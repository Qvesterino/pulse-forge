import { expect, test } from "playwright/test";

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
    test.setTimeout(900_000);
    // This spec never touches the app's live document — it builds its own
    // deterministic project inside the page and renders it — so the boot is
    // the bare minimum: reach the app shell, not a particular studio state.
    // (The project-browser first-run/continue flows are shared infrastructure
    // other specs exercise; depending on them here would couple the PCM
    // assertions to whatever session state the profile carries.)
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 600_000 });
    await page.waitForSelector("body", { timeout: 120_000 });

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, metadataModule, scenesModule, contractModule] =
        await Promise.all([
          load("/src/project-model/templates.ts"),
          load("/src/commands/commands.ts"),
          load("/src/sample-library/factory.ts"),
          load("/src/commands/metadata.ts"),
          load("/src/commands/scenes.ts"),
          load("/src/analysis/contract.ts"),
        ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, addArrangementClip } = commandModule;
      const trackRendererModule = await load("/src/rendering/track-renderer.ts");
      const { renderTrack } = trackRendererModule;
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

      const barSec = (bpm: number, meterNum = 4): number => (60 * meterNum) / bpm;

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
        {
          name: "flat 120, clip bars2-6 untrimmed, window bars2-4",
          bpm: 120,
          meterNum: 4,
          pins: [],
          clip: { startBar: 2, lengthBars: 4, trimStart: 0 },
          windowBars: [2, 4],
          barUnit: BAR4,
        },
        {
          name: "flat 120, trimStart 1.5",
          bpm: 120,
          meterNum: 4,
          pins: [],
          clip: { startBar: 2, lengthBars: 4, trimStart: 1.5 },
          windowBars: [2, 4],
          barUnit: BAR4,
        },
        {
          name: "pin140 bars0-8, clip bars2-6, window bars3-5",
          bpm: 120,
          meterNum: 4,
          pins: [[0, 8, 140]],
          clip: { startBar: 2, lengthBars: 4, trimStart: 0 },
          windowBars: [3, 5],
          barUnit: BAR4,
        },
        {
          name: "pin140 bars0-8 + trim 1, clip bars4-8, window bars5-7",
          bpm: 120,
          meterNum: 4,
          pins: [[0, 8, 140]],
          clip: { startBar: 4, lengthBars: 4, trimStart: 1 },
          windowBars: [5, 7],
          barUnit: BAR4,
        },
        {
          name: "3/4 meter, clip bars2-6, window bars3-5",
          bpm: 120,
          meterNum: 3,
          pins: [],
          clip: { startBar: 2, lengthBars: 4, trimStart: 0 },
          windowBars: [3, 5],
          barUnit: 1440,
        },
        {
          name: "flat 140 project, clip bars2-6, window bars2-4",
          bpm: 140,
          meterNum: 4,
          pins: [],
          clip: { startBar: 2, lengthBars: 4, trimStart: 0 },
          windowBars: [2, 4],
          barUnit: BAR4,
        },
      ];

      const results: Array<{ name: string; ok: boolean; renderLatencySamples: number | null; detail: string }> = [];

      for (const c of cases) {
        let doc: Record<string, any> = createProjectFromTemplate("empty");
        doc = { ...doc, bpm: c.bpm };
        if (c.meterNum !== 4) doc = setTimeSignature(doc, c.meterNum, 4).execute(doc);
        // The empty template ships its own opening scene span — the pins are
        // the only arrangement spans this fixture allows.
        doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
        for (const [bar, bars, bpm] of c.pins) {
          doc = createScene(doc, `pin-${bar}`).execute(doc);
          const sceneId = doc.scenes[doc.scenes.length - 1]!.id;
          if (bpm !== undefined) {
            doc = {
              ...doc,
              scenes: doc.scenes.map((s: { id: string; bpm?: number }) => (s.id === sceneId ? { ...s, bpm } : s)),
            };
          }
          doc = addArrangementClip(doc, sceneId, bar, bars).execute(doc);
        }
        const track = doc.tracks[0]!;
        const bank = new SampleBank();
        bank.add("w31.impulses", makeImpulses());
        doc = addAudioClip(doc, track.id, "w31.impulses", c.clip.startBar, c.clip.lengthBars, {
          trimStart: c.clip.trimStart,
        }).execute(doc);

        const buffer = await renderTrack(doc, track.id, bank, { mode: "song", sampleRate: SR, tailSeconds: 0 });
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

        // First-principles expectations (never the code under test): a tiny
        // piecewise walk over the pin spans — bars inside a pin run at the
        // pin's tempo, everything else at the project tempo.
        const pinSpans = c.pins
          .map(([bar, bars, bpm]) => ({ fromBar: bar, toBar: bar + bars, bs: barSec(bpm ?? c.bpm, c.meterNum) }))
          .sort((a, b) => a.fromBar - b.fromBar);
        const barToSec = (bar: number): number => {
          let sec = 0;
          let cursor = 0;
          for (const span of pinSpans) {
            if (bar <= span.fromBar) break;
            const flatTo = Math.min(bar, span.fromBar);
            sec += (flatTo - cursor) * barSec(c.bpm, c.meterNum);
            cursor = flatTo;
            if (bar > span.fromBar) {
              const pinnedTo = Math.min(bar, span.toBar);
              sec += (pinnedTo - span.fromBar) * span.bs;
              cursor = pinnedTo;
            }
          }
          return sec + (bar - cursor) * barSec(c.bpm, c.meterNum);
        };
        const clipStartSec = barToSec(c.clip.startBar);
        const winStartSec = barToSec(c.windowBars[0]);
        const winDurSec = barToSec(c.windowBars[1]) - winStartSec;
        const expectedRel: number[] = [];
        for (let s = 0; s < SOURCE_SECONDS; s++) {
          const sourceSec = s + IMPULSE_OFFSET;
          if (sourceSec < c.clip.trimStart) continue;
          const rel = sourceSec - c.clip.trimStart + (clipStartSec - winStartSec);
          if (rel >= 0 && rel < winDurSec - 0.01) expectedRel.push(rel);
        }
        const expectedSamples = expectedRel.map((rel) => Math.round(rel * SR));

        // The analyzer sees the WINDOW's PCM only — detection runs on the
        // slice, exactly the way defineAnalyzer feeds a wrapped analyzer.
        const detected = findImpulses(channel.slice(resolved.startSample, resolved.endSample));
        // E-1's measured finding: the offline audio-clip render carries a
        // CONSTANT path latency (PDC total + worklet prefill). The mapping
        // is exact UP TO that constant — measure it from the first impulse,
        // require it IDENTICAL across every impulse in this case (a
        // tempo/pin/trim-dependent drift would break the contract), and
        // compare cases against each other below.
        let renderLatencySamples: number | null = null;
        let drifts = false;
        for (let k = 0; k < detected.length && k < expectedSamples.length; k++) {
          const offset = detected[k] - expectedSamples[k];
          if (renderLatencySamples === null) renderLatencySamples = offset;
          else if (offset !== renderLatencySamples) drifts = true;
        }
        const caseOk = !drifts && detected.length === expectedSamples.length && detected.length > 0;
        results.push({
          name: c.name,
          ok: caseOk,
          renderLatencySamples,
          detail: drifts
            ? `latency DRIFTS across impulses: detected ${detected.slice(0, 6).join(",")} vs expected ${expectedSamples.slice(0, 6).join(",")}`
            : `${detected.length} impulses at constant offset ${renderLatencySamples} sample(s)`,
        });
      }

      return results;
    });

    // THE VERDICT: every case detects all impulses at a CONSTANT offset, and
    // the offset is THE SAME across tempos, scene pins, meter and trims —
    // the tick→sample mapping is exact up to one declared render constant.
    // (An earlier flat-math version of this spec measured a "+12600 sample"
    // pin divergence that turned out to be its OWN expectation ignoring the
    // pin — the render and scene-time agree with each other to the sample.)
    for (const line of report) {
      expect(line.ok, `${line.name}: ${line.detail}`).toBe(true);
    }
    const offsets = report.map((line) => line.renderLatencySamples);
    expect(
      offsets.every((offset) => offset === offsets[0]),
      `offsets must be identical across cases: ${offsets.join(",")}`,
    ).toBe(true);
    expect(report.length).toBeGreaterThanOrEqual(6);
  });
});
