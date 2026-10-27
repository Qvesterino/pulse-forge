import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * E-1 — the PCM leg of the analysis-contract timeline mapping (audit
 * "Audio Perception Readiness", experiment E-1; the tick-matrix leg lives in
 * tests/analysis/contract-timeline.test.ts).
 *
 * CLAIM UNDER TEST: `resolveAnalysisWindow` maps a window declared in TICKS
 * to exactly the samples a render of that window contains — across project
 * tempos, scene BPM pins, the 3/4 meter and clip trims, ±1 sample.
 *
 * METHOD (same as spec 29): a real Chromium, a real OfflineAudioContext via
 * the export path's own `renderProject`, and a source whose CONTENT names
 * its own position — unit IMPULSES every 1 s at a half-second offset, so an
 * exact argmax recovers each impulse's sample without interpolation.
 *
 * Every expected position is computed IN PAGE from first principles
 * (bars × barSec(bpm)), never by calling the mapping under test to derive
 * its own expectation.
 */

test.describe("31 — analysis window PCM mapping", () => {
  // WebKit on Windows has no Web Audio media stack — same reason as spec 29.
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("declared windows land on the rendered impulses within ±1 sample", async ({ page }) => {
    test.setTimeout(600_000);
    await openHouseTemplate(page, { timeoutMs: 300_000 });

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, rendererModule, sampleModule, metadataModule, scenesModule, contractModule] =
        await Promise.all([
          load("/src/project-model/templates.ts"),
          load("/src/commands/commands.ts"),
          load("/src/rendering/renderer.ts"),
          load("/src/sample-library/factory.ts"),
          load("/src/commands/metadata.ts"),
          load("/src/commands/scenes.ts"),
          load("/src/analysis/contract.ts"),
        ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, addArrangementClip } = commandModule;
      const { renderProject } = rendererModule;
      const { SampleBank } = sampleModule;
      const { setTimeSignature } = metadataModule;
      const { createScene } = scenesModule;
      const { resolveAnalysisWindow } = contractModule;

      const SR = 44_100;
      const BAR4 = 1920; // 4/4 at PPQ 480
      const SOURCE_SECONDS = 16;
      /** Unit impulses at 0.5, 1.5, … 15.5 s of source. */
      const IMPULSE_OFFSET = 0.5;

      const makeImpulses = (): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, SR * SOURCE_SECONDS, SR).createBuffer(1, SR * SOURCE_SECONDS, SR);
        const samples = buffer.getChannelData(0);
        for (let sec = 0; sec < SOURCE_SECONDS; sec++) samples[Math.round((sec + IMPULSE_OFFSET) * SR)] = 1;
        return buffer;
      };

      /** Find impulse onsets: sample indices where the value exceeds 0.5. */
      const findImpulses = (channel: Float32Array): number[] => {
        const hits: number[] = [];
        for (let i = 0; i < channel.length; i++) {
          if (channel[i]! > 0.5) {
            hits.push(i);
            i++; // one sample per impulse; skip the neighbour
          }
        }
        return hits;
      };

      const barSec = (bpm: number): number => 240 / bpm;

      interface Case {
        name: string;
        bpm: number;
        meterNum: number;
        /** Scene-pin spans: [bar, bars, bpm?] — a fresh scene each. */
        pins: Array<[number, number, number?]>;
        clip: { startBar: number; lengthBars: number; trimStart: number };
        windowBars: [number, number];
        barUnit: number;
      }

      const cases: Case[] = [
        { name: "flat 120, clip bars2-6 untrimmed, window bars2-4", bpm: 120, meterNum: 4, pins: [], clip: { startBar: 2, lengthBars: 4, trimStart: 0 }, windowBars: [2, 4], barUnit: BAR4 },
        { name: "flat 120, trimStart 1.5", bpm: 120, meterNum: 4, pins: [], clip: { startBar: 2, lengthBars: 4, trimStart: 1.5 }, windowBars: [2, 4], barUnit: BAR4 },
        { name: "pin140 bars0-8, clip bars2-6, window bars3-5", bpm: 120, meterNum: 4, pins: [[0, 8, 140]], clip: { startBar: 2, lengthBars: 4, trimStart: 0 }, windowBars: [3, 5], barUnit: BAR4 },
        { name: "pin140 bars0-8 + trim 1, clip bars4-8, window bars5-7", bpm: 120, meterNum: 4, pins: [[0, 8, 140]], clip: { startBar: 4, lengthBars: 4, trimStart: 1 }, windowBars: [5, 7], barUnit: BAR4 },
        { name: "3/4 meter, clip bars2-6, window bars3-5", bpm: 120, meterNum: 3, pins: [], clip: { startBar: 2, lengthBars: 4, trimStart: 0 }, windowBars: [3, 5], barUnit: 1440 },
        { name: "flat 140 project, clip bars2-6, window bars2-4", bpm: 140, meterNum: 4, pins: [], clip: { startBar: 2, lengthBars: 4, trimStart: 0 }, windowBars: [2, 4], barUnit: BAR4 },
      ];

      const results: Array<{ name: string; ok: boolean; detail: string }> = [];

      for (const c of cases) {
        let doc: Record<string, any> = createProjectFromTemplate("empty");
        doc = { ...doc, bpm: c.bpm };
        if (c.meterNum !== 4) doc = setTimeSignature(doc, c.meterNum, 4).execute(doc);
        for (const [bar, bars, bpm] of c.pins) {
          doc = createScene(doc, `pin-${bar}`).execute(doc);
          const sceneId = doc.scenes[doc.scenes.length - 1]!.id;
          if (bpm !== undefined) {
            doc = { ...doc, scenes: doc.scenes.map((s: { id: string; bpm?: number }) => (s.id === sceneId ? { ...s, bpm } : s)) };
          }
          doc = addArrangementClip(doc, sceneId, bar, bars).execute(doc);
        }
        const track = doc.tracks[0]!;
        const bank = new SampleBank();
        bank.add("w31.impulses", makeImpulses());
        doc = addAudioClip(doc, track.id, "w31.impulses", c.clip.startBar, c.clip.lengthBars, {
          trimStart: c.clip.trimStart,
        }).execute(doc);

        const buffer = await renderProject(doc, bank, { sampleRate: SR, quality: "live" });
        const channel = buffer.getChannelData(0);

        const request = {
          projectId: doc.id,
          revision: 1,
          scope: { kind: "track" as const, id: track.id },
          window: { startTick: c.windowBars[0] * c.barUnit, endTick: c.windowBars[1] * c.barUnit },
          stage: "track" as const,
          featureSet: "impulse-probe",
        };
        const resolved = resolveAnalysisWindow(doc, request, SR);

        // First-principles expectations (never the code under test):
        const bs = barSec(c.bpm);
        const clipStartSec = c.clip.startBar * bs;
        const winStartSec = c.windowBars[0] * bs;
        const winDurSec = (c.windowBars[1] - c.windowBars[0]) * bs;
        const expectedRel: number[] = [];
        for (let s = 0; s < SOURCE_SECONDS; s++) {
          const sourceSec = s + IMPULSE_OFFSET;
          if (sourceSec < c.clip.trimStart) continue;
          const rel = sourceSec - c.clip.trimStart + (clipStartSec - winStartSec);
          if (rel >= 0 && rel < winDurSec - 0.01) expectedRel.push(rel);
        }
        const expectedSamples = expectedRel.map((rel) => Math.round(rel * SR));

        const detected = findImpulses(channel).map((idx) => idx - resolved.startSample);
        const inWindow = expectedSamples.filter((pos) => pos >= -1 && pos <= channel.length - resolved.startSample + 1);
        let ok = detected.length === inWindow.length;
        const worst = Math.max(
          ...expectedSamples.map((pos) => {
            const nearest = detected.reduce((best, d) => (Math.abs(d - pos) < Math.abs(best - pos) ? d : best), Number.MAX_SAFE_INTEGER);
            return Math.abs(nearest - pos);
          }),
        );
        if (worst > 1) ok = false;
        results.push({
          name: c.name,
          ok,
          detail: ok
            ? `${detected.length} impulses, worst offset ${worst} sample(s)`
            : `detected ${detected.length} [${detected.slice(0, 6).join(",")}] vs expected ${inWindow.length} [${inWindow.slice(0, 6).join(",")}] at samples ${resolved.startSample}..${resolved.endSample}`,
        });
      }

      return results;
    });

    for (const line of report) {
      expect(line.ok, `${line.name}: ${line.detail}`).toBe(true);
    }
    expect(report.length).toBeGreaterThanOrEqual(6);
  });
});
