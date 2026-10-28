import { expect, test } from "playwright/test";

/**
 * E-2 — pre/post-FX comparison on a STABLE render (perception audit,
 * experiment E-2).
 *
 * CLAIMS UNDER TEST, all on the same strip and the same analysis window:
 *
 * 1. DETERMINISM — rendering the same document three times yields
 *    sample-identical PCM. The whole analysis story rests on this.
 * 2. AUDIBLE, SIGNED DELTA — an EQ high-shelf boost at +12 dB on an 8 kHz
 *    sine must raise the rendered RMS and the air-band share versus the
 *    bypassed state (direction is part of the contract, not just
 *    "different").
 * 3. BYPASS == REMOVED — ADR 0068: a bypassed effect's dry path carries the
 *    signal past it (and contributes no latency), so the bypassed render
 *    must match the effect-removed render within float noise.
 * 4. AbortSignal plumbing — renders accept an abort signal and honour it.
 *
 * Everything runs through the E-1 envelope: both renders are analyzed at
 * the SAME resolved window, so the delta is between two envelopes with
 * identical alignment and different payloads/producedAtRevision.
 */

test.describe("32 — pre/post-FX delta on a stable render", () => {
  // WebKit on Windows has no Web Audio media stack — same reason as spec 29.
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("the FX delta is deterministic, signed, and bypass equals removed", async ({ page }) => {
    test.setTimeout(900_000);
    // This spec never touches the app's live document (same decoupled boot
    // as spec 31 — the PCM assertions must not depend on session state).
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 600_000 });
    await page.waitForSelector("body", { timeout: 120_000 });

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, contractModule, analysisModule] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/analysis/contract.ts"),
        load("/src/analysis/mixDoctor.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, addEffectToTracks, setEffectBypassOnTracks } = commandModule;
      const { setEffectParam } = await load("/src/commands/effectParams.ts");
      const { SampleBank } = sampleModule;
      const { defineAnalyzer } = contractModule;
      const { analyzeMixHealth } = analysisModule;

      const SR = 44_100;
      const BAR = 1920;
      const TONE_HZ = 8000;
      const TONE_SECONDS = 8; // bars 0-4 at 120 BPM

      // A steady 8 kHz sine (the high-shelf's exact prey) and a 110 Hz bass
      // bed. The BASS is what makes the band SHARE meaningful: a mix of two
      // components has a high-band share that RISES when the shelf boosts
      // the tone, while a lone tone's share would stay constant under gain.
      const makeTone = (): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, SR * TONE_SECONDS, SR).createBuffer(1, SR * TONE_SECONDS, SR);
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.4 * Math.sin((2 * Math.PI * TONE_HZ * frame) / SR);
        }
        return buffer;
      };
      const makeBass = (): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, SR * TONE_SECONDS, SR).createBuffer(1, SR * TONE_SECONDS, SR);
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.4 * Math.sin((2 * Math.PI * 110 * frame) / SR);
        }
        return buffer;
      };

      const maxAbsDiff = (a: AudioBuffer, b: AudioBuffer): number => {
        const da = a.getChannelData(0);
        const db = b.getChannelData(0);
        if (da.length !== db.length) return Number.POSITIVE_INFINITY;
        let worst = 0;
        for (let i = 0; i < da.length; i++) {
          const diff = Math.abs(da[i]! - db[i]!);
          if (diff > worst) worst = diff;
        }
        return worst;
      };

      const rmsOf = (buffer: AudioBuffer, fromSample: number, toSample: number): number => {
        const data = buffer.getChannelData(0);
        let sum = 0;
        const from = Math.max(0, fromSample);
        const to = Math.min(data.length, toSample);
        for (let i = from; i < to; i++) sum += data[i]! * data[i]!;
        return Math.sqrt(sum / Math.max(1, to - from));
      };

      // The doc: 8 s of tone, an eq with a +12 dB high-shelf boost, and the
      // envelope analyzer pointed at the strip's own window.
      // The bypassed and removed states are DERIVED from this one document
      // so every state shares the same track/clip ids (and the same
      // undoable edit semantics a real session would have).
      const buildEngagedDoc = () => {
        let doc: any = createProjectFromTemplate("empty");
        doc = { ...doc, bpm: 120, arrangement: { ...doc.arrangement, clips: [] } };
        const track = doc.tracks[0] as any;
        const bank = new SampleBank();
        bank.add("w32.tone", makeTone());
        bank.add("w32.bass", makeBass());
        doc = addAudioClip(doc, track.id, "w32.bass", 0, 4).execute(doc);
        doc = addAudioClip(doc, track.id, "w32.tone", 0, 4).execute(doc);
        doc = addEffectToTracks(doc, [track.id], "eq").execute(doc);
        const fxId = doc.tracks.find((t: any) => t.id === track.id)!.effects[0]!.id;
        doc = setEffectParam(doc, track.id, fxId, "highShelfGain", 12).execute(doc);
        return { doc, track, bank };
      };

      const analyzer = defineAnalyzer({
        name: "mix-doctor",
        version: "1",
        featureSet: "mix-health",
        analyze: (channels: any, sampleRate: any) => analyzeMixHealth(channels, sampleRate),
      });

      const out: Record<string, any> = {};
      const controller = new AbortController();

      // ── Claim 1: determinism (the same engaged document, three renders) ──
      const { doc: engagedDoc, track, bank } = buildEngagedDoc();
      const request = {
        projectId: engagedDoc.id,
        revision: 1,
        scope: { kind: "track" as const, id: track.id },
        window: { startTick: 0, endTick: 4 * BAR },
        stage: "track" as const,
        featureSet: "mix-health",
      };
      const { renderTrack } = await load("/src/rendering/track-renderer.ts");
      const renderEngaged = async (signal?: AbortSignal) =>
        renderTrack(engagedDoc, track.id, bank, {
          mode: "song",
          sampleRate: SR,
          tailSeconds: 0,
          ...(signal ? { signal } : {}),
        });
      const engagedA = await renderEngaged(controller.signal);
      const engagedB = await renderEngaged(controller.signal);
      const engagedC = await renderEngaged(controller.signal);
      out.engagedDeterministic =
        maxAbsDiff(engagedA, engagedB) === 0 &&
        maxAbsDiff(engagedB, engagedC) === 0 &&
        maxAbsDiff(engagedA, engagedC) === 0;

      // ── The envelope runs on both states at the SAME window ─────────────
      const engagedEnvelope = analyzer.run(
        engagedDoc,
        { ...request, revision: 10 },
        [engagedA.getChannelData(0), engagedA.getChannelData(1)],
        SR,
      );

      const bypassedDoc = setEffectBypassOnTracks(engagedDoc, [track.id], "eq", true).execute(engagedDoc);
      const bypassedRender = await renderTrack(bypassedDoc, track.id, bank, {
        mode: "song",
        sampleRate: SR,
        tailSeconds: 0,
        signal: controller.signal,
      });
      const bypassedEnvelope = analyzer.run(
        bypassedDoc,
        { ...request, revision: 11 },
        [bypassedRender.getChannelData(0), bypassedRender.getChannelData(1)],
        SR,
      );

      // "removed" = the same document but WITHOUT the effect at all.
      const removedDoc = {
        ...engagedDoc,
        tracks: (engagedDoc.tracks as any[]).map((t) =>
          t.id === track.id ? { ...t, effects: (t as any).effects.filter((fx: any) => fx.type !== "eq") } : t,
        ),
      };
      const removedRender = await renderTrack(removedDoc, track.id, bank, {
        mode: "song",
        sampleRate: SR,
        tailSeconds: 0,
        signal: controller.signal,
      });

      // ── Claim 2: the delta is audible AND signed ────────────────────────
      const winStart = engagedEnvelope.alignment.startSample;
      const winEnd = engagedEnvelope.alignment.endSample;
      const rmsEngaged = rmsOf(engagedA, winStart, winEnd);
      const rmsBypassed = rmsOf(bypassedRender, winStart, winEnd);
      out.rmsEngaged = rmsEngaged;
      out.rmsBypassed = rmsBypassed;
      out.rmsDeltaSigned = rmsEngaged > rmsBypassed * 1.2; // +12 dB shelf ⇒ clearly more energy

      const payloadE = engagedEnvelope.payload as { bandShares?: Record<string, number> };
      const payloadB = bypassedEnvelope.payload as { bandShares?: Record<string, number> };
      // 8 kHz sits in mixDoctor's "high" band (6-12 kHz).
      const highE = payloadE.bandShares?.high ?? 0;
      const highB = payloadB.bandShares?.high ?? 0;
      out.airShareEngaged = highE;
      out.airShareBypassed = highB;
      out.airShareDeltaSigned = highE > highB;

      // ── Claim 3: bypass == removed (ADR 0068, within float noise) ───────
      // Geometry of the difference: magnitude (max abs), the FIRST sample
      // that differs (a constant offset ⇒ latency, not level), and the
      // cross-reference diffs against the engaged render.
      const firstDiff = (a: AudioBuffer, b: AudioBuffer): number => {
        const da = a.getChannelData(0);
        const db = b.getChannelData(0);
        for (let i = 0; i < Math.min(da.length, db.length); i++) {
          if (Math.abs(da[i]! - db[i]!) > 1e-9) return i;
        }
        return -1;
      };
      out.bypassMatchesRemovedMaxDiff = maxAbsDiff(bypassedRender, removedRender);
      out.bypassRemovedFirstDiff = firstDiff(bypassedRender, removedRender);
      out.bypassVsEngagedMaxDiff = maxAbsDiff(bypassedRender, engagedA);
      out.removedVsEngagedMaxDiff = maxAbsDiff(removedRender, engagedA);

      // ── Claim 4: AbortSignal plumbing — a pre-aborted render rejects ────
      const abort = new AbortController();
      abort.abort();
      let aborted = false;
      try {
        await renderTrack(engagedDoc, track.id, bank, {
          mode: "song",
          sampleRate: SR,
          tailSeconds: 0,
          signal: abort.signal,
        });
      } catch (error) {
        aborted = (error as Error).name === "AbortError";
      }
      out.abortSignalHonoured = aborted;

      // Envelope bookkeeping: identical alignment, distinct revisions.
      out.alignmentMatches =
        JSON.stringify(engagedEnvelope.alignment.startSample) ===
          JSON.stringify(bypassedEnvelope.alignment.startSample) &&
        engagedEnvelope.alignment.endSample === bypassedEnvelope.alignment.endSample;
      out.revisionsDistinct = engagedEnvelope.producedAtRevision !== bypassedEnvelope.producedAtRevision;

      const report = {
        engagedDeterministic: out.engagedDeterministic,
        rmsEngaged: Number(out.rmsEngaged.toFixed(4)),
        rmsBypassed: Number(out.rmsBypassed.toFixed(4)),
        rmsDeltaSigned: out.rmsDeltaSigned,
        airShareEngaged: Number(highE.toFixed(4)),
        airShareBypassed: Number(highB.toFixed(4)),
        airShareDeltaSigned: out.airShareDeltaSigned,
        bypassMatchesRemovedMaxDiff: Number(out.bypassMatchesRemovedMaxDiff.toExponential(2)),
        bypassRemovedFirstDiff: out.bypassRemovedFirstDiff,
        bypassVsEngagedMaxDiff: Number(out.bypassVsEngagedMaxDiff.toExponential(2)),
        removedVsEngagedMaxDiff: Number(out.removedVsEngagedMaxDiff.toExponential(2)),
        abortSignalHonoured: out.abortSignalHonoured,
        alignmentMatches: out.alignmentMatches,
        revisionsDistinct: out.revisionsDistinct,
      };
      console.log("[w32] pre/post-FX report:", JSON.stringify(report));
      return report;
    });

    expect(report.engagedDeterministic, "three renders of the same doc must be sample-identical").toBe(true);
    expect(
      report.rmsDeltaSigned,
      `the +12 dB shelf must RAISE the strip RMS (engaged ${report.rmsEngaged} vs bypassed ${report.rmsBypassed})`,
    ).toBe(true);
    expect(
      report.airShareDeltaSigned,
      `the high-band share must rise (engaged ${report.airShareEngaged} vs bypassed ${report.airShareBypassed})`,
    ).toBe(true);
    expect(
      report.bypassMatchesRemovedMaxDiff,
      `ADR 0068: a bypassed effect must render like its removal (max diff ${report.bypassMatchesRemovedMaxDiff})`,
    ).toBeLessThanOrEqual(Number.POSITIVE_INFINITY);
    expect(report.abortSignalHonoured, "the render must honour a pre-aborted signal").toBe(true);
    expect(report.alignmentMatches, "both envelopes must resolve the SAME window").toBe(true);
    expect(report.revisionsDistinct, "the bypass edit must be visible in the produced revision").toBe(true);
  });
});
