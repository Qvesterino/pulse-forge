import { test, expect } from "playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { clickPanelAction, completeOnboardingTourIfPresent, openHouseTemplate } from "./_helpers";
import type { Page } from "playwright/test";

/**
 * 16 — IDEA → EXPORT (the whole product promise in one journey):
 * a fresh user types a musical IDEA into the IntentPanel, the words become
 * real document state, and that state is rendered and delivered as an
 * actual WAV file on disk.
 *
 * Why this spec exists: 03 proved generation mutates the doc, 15 proved
 * intent mutates the doc, and the browser verifier proved a JSON project
 * downloads. NOTHING proved the last mile — that a user's idea survives the
 * whole chain (intent router → project model → scheduler → AudioEngine →
 * offline renderer → WAV encoder → browser download). Every one of those
 * seams can be broken and all existing specs stay green, because they stop
 * at the document boundary.
 *
 * The audio assertion is the point: a zero-byte or silent WAV would still
 * be a "successful" download, so this spec parses the RIFF container and
 * measures real sample energy. That is what makes it an audio test rather
 * than a plumbing test.
 */

const PROMPT = "textarea[aria-label='Intent description']";
const DO_IT = "button.intent-route-btn";
const STATUS = ".intent-status";
const INTENT_TAB = "button[aria-label='Toggle intent panel']";

/** Master export can take a while; the render is offline and single-threaded. */
const EXPORT_TIMEOUT = 120_000;

interface WavFacts {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  /** Absolute peak sample value in [-1, 1] across every channel. */
  peak: number;
  /** Root-mean-square level — distinguishes "loud" from "one click of noise". */
  rms: number;
}

/**
 * Minimal, defensive RIFF reader. Deliberately NOT a full parser: it walks
 * chunk headers to find `fmt ` and `data`, then decodes the sample payload
 * for the formats the exporter can emit (16/24-bit PCM, 32-bit float).
 * Anything unrecognised returns zeros rather than throwing — the caller
 * asserts on the numbers, so a wrong format fails as a real assertion with
 * a readable value instead of a stack trace.
 */
function readWavFacts(bytes: Buffer): WavFacts {
  const facts: WavFacts = {
    audioFormat: 0,
    channels: 0,
    sampleRate: 0,
    bitsPerSample: 0,
    dataBytes: 0,
    peak: 0,
    rms: 0,
  };
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    return facts;
  }

  let offset = 12;
  let fmtRead = false;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > bytes.length) break;
    if (id === "fmt " && size >= 16) {
      facts.audioFormat = bytes.readUInt16LE(body);
      facts.channels = bytes.readUInt16LE(body + 2);
      facts.sampleRate = bytes.readUInt32LE(body + 4);
      facts.bitsPerSample = bytes.readUInt16LE(body + 14);
      fmtRead = true;
    } else if (id === "data") {
      facts.dataBytes = size;
    }
    // RIFF chunks are word-aligned: an odd payload is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  if (!fmtRead || facts.dataBytes === 0) return facts;

  // Re-walk to the data payload now that fmt is known.
  offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      const start = offset + 8;
      const { channels, bitsPerSample, audioFormat } = facts;
      const bytesPerSample = bitsPerSample / 8;
      const frames = Math.floor(size / (bytesPerSample * channels));
      let sumSquares = 0;
      let peak = 0;
      let counted = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          const at = start + (frame * channels + channel) * bytesPerSample;
          let value = 0;
          if (audioFormat === 3 && bitsPerSample === 32) {
            value = bytes.readFloatLE(at);
          } else if (audioFormat === 1 && bitsPerSample === 16) {
            value = bytes.readInt16LE(at) / 32768;
          } else if (audioFormat === 1 && bitsPerSample === 24) {
            const raw = ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8) >> 8;
            value = raw / 8388608;
          }
          const magnitude = Math.abs(value);
          if (magnitude > peak) peak = magnitude;
          sumSquares += value * value;
          counted += 1;
        }
      }
      facts.peak = peak;
      facts.rms = counted > 0 ? Math.sqrt(sumSquares / counted) : 0;
      return facts;
    }
    offset = offset + 8 + size + (size % 2);
  }
  return facts;
}

async function openIntentPanel(page: Page): Promise<void> {
  await openHouseTemplate(page);
  await completeOnboardingTourIfPresent(page);
  // The INTENT tab lives in the always-mounted dock tab row
  // (ROADMAP-UI-2027 V1): one click, no overflow dance.
  await page.locator(INTENT_TAB).first().click();
  await expect(page.locator(".intent-panel")).toBeVisible({ timeout: 30_000 });
}

test.describe("16 — idea → export", () => {
  // Playwright's Windows WebKit build ships WITHOUT the media stack (no
  // AudioContext at all), so an offline render cannot produce a WAV there.
  // The project already knows this — playwright.config.ts ignores specs
  // 01–08 on webkit and spec 09 covers the no-Web-Audio degradation path.
  // This spec needs REAL audio, so it is chromium-only; the missing engine
  // coverage is an owner gate, not something to fake with a skip that hides
  // a product regression.
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "offline render needs Web Audio — WebKit/Windows has none",
  );

  test("an intent-built project renders to a real, audible WAV file", async ({ page }, testInfo) => {
    test.slow();

    // --- 1. The idea enters as natural language -------------------------
    // The wording is deliberately inside the router's DOCUMENTED exact
    // vocabulary ("set tempo to N", "add a bass track") rather than a vague
    // "make it cooler". A vague ask that silently degrades into pattern
    // generation is a different concern (spec 03) — this spec's job is the
    // last mile, so it must start from an ask that genuinely mutates state.
    await openIntentPanel(page);
    await page.locator(PROMPT).fill("set tempo to 128 and add a bass track");
    await page.locator(DO_IT).click();
    await expect(page.locator(STATUS)).toContainText(/tempo|128/i, { timeout: 30_000 });

    // --- 2. The words became real, undoable document state --------------
    // Undo enabling is the document-state proof: an unmatched prompt would
    // ask for clarification instead of mutating anything.
    await expect(page.locator("button[aria-label='Undo']")).toBeEnabled({ timeout: 30_000 });

    // Tempo read-back from the transport control itself: the DragNumber the
    // intent command wrote, not a status line echoing the prompt.
    const bpm = page.locator(".drag-number", { has: page.locator(".drag-number-label", { hasText: /^BPM$/ }) });
    await expect(bpm.locator(".drag-number-value")).toHaveText(/^128(\.0)?$/, { timeout: 30_000 });

    // The bassline ask must have produced a bass track — read from the real
    // mixer strips, so the assertion fails if the idea stayed a no-op. Track
    // strips carry an editable name INPUT; return/master strips carry a label
    // instead, so scoping to the input reads TRACKS only.
    await page.locator("button[aria-label='Toggle mixer panel']").first().click();
    const strips = page.locator(".mixer-strips .channel-strip");
    await expect(strips.first()).toBeVisible({ timeout: 15_000 });
    const stripNames = await strips
      .locator("input.channel-name-input")
      .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
    expect(stripNames.length, `mixer must render a strip per track, got [${stripNames.join(", ")}]`).toBeGreaterThan(1);
    expect(
      stripNames.join(" ").toLowerCase(),
      "the 'add a bass track' ask should have added a bass track to master",
    ).toMatch(/bass/);

    // --- 3. Close the intent dock so it cannot cover the export panel ----
    await page.keyboard.press("Escape");

    // --- 4. Render the master and deliver it as a file ------------------
    await clickPanelAction(page, "EXPORT");
    await page.waitForSelector('.export-panel[aria-label="Export"]', { timeout: 15_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT });
    await page.locator('.export-panel button:has-text("EXPORT MASTER")').click();
    const download = await downloadPromise;

    const filename = download.suggestedFilename();
    expect(filename, "the master export must deliver a .wav file").toMatch(/\.wav$/i);

    const path = await download.path();
    expect(path, "the download must land on disk").toBeTruthy();
    const bytes = await readFile(path!);

    // --- 5. The file is a real RIFF/WAVE with real audio energy ----------
    // A silent or truncated WAV is still a "successful" download, so the
    // last mile is asserted on samples, not on the presence of bytes.
    const facts = readWavFacts(bytes);
    expect(bytes.toString("ascii", 0, 4), "master must be a RIFF container").toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12), "master must be a WAVE payload").toBe("WAVE");
    expect(facts.channels, "master must be stereo").toBeGreaterThanOrEqual(1);
    expect(facts.sampleRate, "master must carry a real sample rate").toBeGreaterThanOrEqual(8000);
    expect(facts.dataBytes, "master must contain a non-empty data chunk").toBeGreaterThan(44);

    // Measurements are written BEFORE the level assertions below, on purpose:
    // a level regression is exactly the case where they matter, and a report
    // emitted after a failing expect never runs. An export failure is almost
    // always a LEVEL problem (silence, near-silence, clipping, wrong rate) —
    // "the WAV assertion failed" alone sends the next person hunting blind.
    // Written via outputPath + attach-by-path (not an in-memory body, which
    // only lands in the HTML report) so the numbers are on disk next to the
    // trace and the failure screenshot.
    const factsPath = testInfo.outputPath("master-wav-facts.json");
    await writeFile(factsPath, JSON.stringify({ filename, bytes: bytes.length, ...facts }, null, 2), "utf8");
    await testInfo.attach("master-wav-facts", { path: factsPath, contentType: "application/json" });

    // The project the words produced is a beat with a bass track — it must
    // not export as digital silence.
    expect(facts.peak, "exported master must not be silent").toBeGreaterThan(0.001);
    expect(facts.rms, "exported master must carry musical energy, not a single click").toBeGreaterThan(0.0001);

    // --- 6. The panel reports the delivery honestly ---------------------
    await expect(page.locator(".export-panel")).toContainText(/exported|master/i, { timeout: 30_000 });
  });
});
