import { expect, test } from "playwright/test";
import type { ProjectDocument } from "../../src/project-model/types";
import { openHouseTemplate } from "./_helpers";

/**
 * WAVE 20 — render verification for the wave-19 audio verbs.
 *
 * WHY THIS WAVE EXISTS, stated plainly: wave 19 marked slip, stretch, crossfade,
 * mute, consolidate, strip-silence and slice **VERIFIED**, but it only proved the
 * state change, the history and the persistence. The objective's acceptance gate
 * says more than that:
 *
 *   "A tool is VERIFIED only if its user interaction, intended state change,
 *    history behavior and persistence are exercised successfully; AUDIO-AFFECTING
 *    EDITS ALSO REQUIRE APPLICABLE RENDERING VERIFICATION."
 *
 * So those seven verdicts were incomplete by the objective's own definition. A
 * clip can carry a perfectly correct `stretchRate` or `slip` offset and still
 * render the wrong audio — and no jsdom test in this repository can catch it,
 * because every render test stubs `OfflineAudioContext` rather than running one.
 * (Confirmed: no test under tests/ calls `startRendering`.)
 *
 * METHOD: a real Chromium, a real `OfflineAudioContext`, the same
 * `renderProject(doc, SampleBank, ...)` the export path uses, and a Goertzel-style
 * single-frequency probe so each assertion can name WHICH source is audible
 * rather than only that "something changed".
 *
 * Two distinct tones are used as source material (220 Hz and 550 Hz) so a clip
 * that should be silent, replaced or heard-in-the-overlap is distinguishable from
 * one that is merely louder.
 */

test.describe("20 — audio-edit render verification", () => {
  // WebKit on Windows has no Web Audio media stack — same reason as spec 12.
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("each audio verb changes the RENDERED audio, not just the document", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page);

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, rendererModule, durationModule] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/rendering/renderer.ts"),
        load("/src/commands/audioClips.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, sliceAudioClipToArrangement } = commandModule;
      const { slipAudioClip, stretchAudioClip, setAudioClipsMute, stripSilenceAudioClip, crossfadeAudioClips } =
        commandModule;
      const { SampleBank } = sampleModule;
      const { renderProject } = rendererModule;
      const { audioClipDurationSec } = durationModule;

      const sampleRate = 44_100;
      // The empty template runs at 120 BPM, so ONE BAR = 2 s: a 4-bar clip is
      // 8 s and a 6-bar clip is 12 s. The first version of this fixture used
      // 4 s buffers, and the CONTROL caught it — `baselineLowLate` measured
      // 0.0005 at t=4.5 s, because the source had already ended and the rest of
      // the clip was silence. A control that only proves "something was heard"
      // would have missed exactly that. 12 s covers every clip below.
      const TONE_SECONDS = 12;
      const makeTone = (frequency: number): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, sampleRate * TONE_SECONDS, sampleRate).createBuffer(
          1,
          sampleRate * TONE_SECONDS,
          sampleRate,
        );
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
        }
        return buffer;
      };
      const bank = new SampleBank();
      bank.add("w20.low", makeTone(220));
      bank.add("w20.high", makeTone(550));

      const template = createProjectFromTemplate("empty");
      const track = template.tracks[0];
      if (!track) throw new Error("empty-project audio track fixture missing");
      const bare = { ...template, arrangement: { ...template.arrangement, clips: [], audioClips: [] } };

      /** Single-frequency amplitude probe (Goertzel): names WHICH tone is heard. */
      const amplitudeAt = (buffer: AudioBuffer, frequency: number, startSec: number, windowSec = 0.35): number => {
        const samples = buffer.getChannelData(0);
        const start = Math.round(sampleRate * startSec);
        const count = Math.round(sampleRate * windowSec);
        let real = 0;
        let imaginary = 0;
        for (let index = 0; index < count; index++) {
          const sample = samples[start + index] ?? 0;
          const phase = (2 * Math.PI * frequency * index) / sampleRate;
          real += sample * Math.cos(phase);
          imaginary -= sample * Math.sin(phase);
        }
        return (2 * Math.hypot(real, imaginary)) / count;
      };
      const rms = (buffer: AudioBuffer, startSec: number, windowSec = 0.35): number => {
        const samples = buffer.getChannelData(0);
        const start = Math.round(sampleRate * startSec);
        const count = Math.round(sampleRate * windowSec);
        let sum = 0;
        for (let index = 0; index < count; index++) sum += (samples[start + index] ?? 0) ** 2;
        return Math.sqrt(sum / Math.max(1, count));
      };

      const withLowAt0 = addAudioClip(bare, track.id, "w20.low", 0, 4).execute(bare);
      const withLowAndHigh = addAudioClip(withLowAt0, track.id, "w20.high", 2, 4).execute(withLowAt0);

      const render = async (project: ProjectDocument) =>
        renderProject(project, bank, { mode: "song", sampleRate, tailSeconds: 0 });

      // ── CONTROL: the untouched pair renders BOTH tones ────────────────────
      // Without this, every "tone X is absent" assertion below would also be
      // satisfied by a fixture that never rendered anything at all.
      const baseline = await render(withLowAndHigh);
      const out: Record<string, unknown> = {
        // `w20.low` occupies bars 0-4, `w20.high` bars 2-6.
        baselineLowEarly: amplitudeAt(baseline, 220, 0.5),
        baselineLowLate: amplitudeAt(baseline, 220, 4.5),
        baselineHighEarly: amplitudeAt(baseline, 550, 0.5),
        baselineHighLate: amplitudeAt(baseline, 550, 4.5),
        baselineRmsOverlap: rms(baseline, 2.5),
        baselineDurationSec: audioClipDurationSec(withLowAndHigh, 4, 0),
      };

      // ── MUTE: a muted clip must be SILENT, not merely quieter ─────────────
      // Isolated on purpose. The first version measured RMS at 4.5 s in the
      // OVERLAPPING pair, where the unmuted neighbour is still sounding — so
      // the 550 Hz probe correctly read "muted works" while the RMS probe read
      // 0.09 and looked like a failure. An energy probe cannot tell you WHICH
      // clip contributed. Here the clips do not overlap: `w20.low` bars 0-2
      // (0-4 s) and `w20.high` bars 4-8 (8-16 s), so at t=9 s only the muted
      // clip can possibly be making sound.
      const soloDoc = addAudioClip(bare, track.id, "w20.low", 0, 2).execute(bare);
      const pairDoc = addAudioClip(soloDoc, track.id, "w20.high", 4, 4).execute(soloDoc);
      const soloHighId = pairDoc.arrangement.audioClips?.find(
        (c: { bufferId: string }) => c.bufferId === "w20.high",
      )?.id;
      if (!soloHighId) throw new Error("mute fixture lost the high clip");

      const beforeMute = await render(pairDoc);
      out.unmutedLateRms = rms(beforeMute, 9); // the clip that is about to be muted
      const muteDoc = setAudioClipsMute(pairDoc, [soloHighId], true).execute(pairDoc);
      const mutedRender = await render(muteDoc);
      out.muteLateRms = rms(mutedRender, 9);
      out.muteLateHigh = amplitudeAt(mutedRender, 550, 9);
      out.muteEarlyRms = rms(mutedRender, 1); // the untouched clip must still sound

      // ── SLIP: same position, same length, DIFFERENT source material ───────
      // A pure tone cannot distinguish a slip (which changes WHICH part of the
      // source is heard) from a move. So the slip fixture uses a source that
      // changes character over time: a tone that shifts frequency at 2 s.
      const ramp = new OfflineAudioContext(1, sampleRate * TONE_SECONDS, sampleRate).createBuffer(
        1,
        sampleRate * TONE_SECONDS,
        sampleRate,
      );
      {
        const samples = ramp.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          const t = frame / sampleRate;
          // 220 Hz for the first 2 s of SOURCE, 550 Hz after. A slip of 2 s
          // therefore changes which half is heard at the same timeline position.
          const frequency = t < 2 ? 220 : 550;
          samples[frame] = 0.2 * Math.sin(2 * Math.PI * frequency * t);
        }
      }
      bank.add("w20.ramp", ramp);
      const ramped = addAudioClip(bare, track.id, "w20.ramp", 0, 4).execute(bare);
      const rampBefore = await render(ramped);
      const rampId = ramped.arrangement.audioClips?.[0]?.id ?? "missing";
      const slipped = slipAudioClip(ramped, rampId, 2).execute(ramped);
      const rampAfter = await render(slipped);
      // At the SAME timeline position (0.5 s), the unslipped clip is 220 Hz and
      // the slipped clip is 550 Hz — because it is now hearing t=2.5 s of source.
      out.slipBeforeLow = amplitudeAt(rampBefore, 220, 0.5);
      out.slipBeforeHigh = amplitudeAt(rampBefore, 550, 0.5);
      out.slipAfterLow = amplitudeAt(rampAfter, 220, 0.5);
      out.slipAfterHigh = amplitudeAt(rampAfter, 550, 0.5);
      const slippedClip = slipped.arrangement.audioClips?.[0] as
        { startBar: number; lengthBars: number; offsetSec: number } | undefined;
      out.slipStartBar = slippedClip?.startBar;
      out.slipLengthBars = slippedClip?.lengthBars;
      out.slipOffsetSec = slippedClip?.offsetSec;

      // ── STRETCH: longer clip, same content, rate clamped by the engine ─────
      // Reference render of the UNSTRETCHED pair, so the 220 -> 110 Hz shift can
      // be attributed to the stretch rather than to the fixture.
      const xfBeforeRef = await render(withLowAndHigh);
      const lowIdForStretch =
        withLowAndHigh.arrangement.audioClips?.find((c: { bufferId: string }) => c.bufferId === "w20.low")?.id ??
        "missing";
      const stretched = stretchAudioClip(withLowAndHigh, lowIdForStretch, 8, 0.5).execute(withLowAndHigh);
      const stretchClip = stretched.arrangement.audioClips?.find((c: { id: string }) => c.id === lowIdForStretch) as
        { lengthBars: number; stretchRate: number } | undefined;
      out.stretchLengthBars = stretchClip?.lengthBars;
      out.stretchRate = stretchClip?.stretchRate;
      const stretchRender = await render(stretched);
      // A 4→8 bar stretch at rate 0.5 slows playback, and `stretchRate` is a
      // RESAMPLE rate, not a pitch-preserving phase vocoder: a 220 Hz source
      // therefore arrives an octave down at 110 Hz. Asserting on 220 alone
      // reads as "the stretched clip rendered silence" — which is what the
      // first version of this spec reported at 0.0014. Probing BOTH frequencies
      // turns that confusion into the actual finding.
      out.stretchEarlyLow = amplitudeAt(stretchRender, 220, 0.5);
      out.stretchEarlyShifted = amplitudeAt(stretchRender, 110, 0.5);
      // Reference: the unstretched clip really is 220 Hz at the same point.
      out.unstretchedEarlyLow = amplitudeAt(xfBeforeRef, 220, 0.5);

      // ── SLICE: fragments must TILE the original range, with no gap ─────────
      const toSlice = addAudioClip(bare, track.id, "w20.low", 0, 4).execute(bare);
      const sliceId = toSlice.arrangement.audioClips?.[0]?.id ?? "missing";
      // Bar 4 at 120 BPM = 8 s, so slice points at 2 s and 4 s.
      const sliced = sliceAudioClipToArrangement(toSlice, sliceId, [2, 4]).execute(toSlice);
      const fragments = (sliced.arrangement.audioClips ?? []) as Array<{
        startBar: number;
        lengthBars: number;
        fadeIn: number;
        fadeOut: number;
      }>;
      out.sliceCount = fragments.length;
      out.sliceGeometry = fragments.map((c) => [c.startBar, c.lengthBars]);
      out.sliceFades = fragments.map((c) => [c.fadeIn, c.fadeOut]);
      out.sliceRmsMid = fragments.length ? rms(await render(sliced), 1.5) : 0;
      // No fragment may carry a fade longer than itself (the D1 invariant, now
      // checked where it can actually be observed - in the render).
      out.sliceFadeOvershoot = fragments.filter((c) => c.fadeIn > c.lengthBars || c.fadeOut > c.lengthBars).length;

      // ── STRIP SILENCE: only the requested segments survive ────────────────
      const toStrip = addAudioClip(bare, track.id, "w20.ramp", 0, 4).execute(bare);
      const stripId = toStrip.arrangement.audioClips?.[0]?.id ?? "missing";
      const stripped = stripSilenceAudioClip(
        toStrip,
        stripId,
        [
          { startSec: 0, endSec: 1 },
          { startSec: 3, endSec: 4 },
        ],
        4,
      ).execute(toStrip);
      const stripSegments = (stripped.arrangement.audioClips ?? []) as Array<{ startBar: number; lengthBars: number }>;
      out.stripCount = stripSegments.length;
      out.stripGeometry = stripSegments.map((c) => [c.startBar, c.lengthBars]);
      const stripRender = await render(stripped);
      // The first kept segment is source 0-1 s, which is the 220 Hz half.
      out.stripFirstLow = amplitudeAt(stripRender, 220, 0.5);
      out.stripFirstHigh = amplitudeAt(stripRender, 550, 0.5);

      // ── CROSSFADE: equal power, so the overlap must NOT dip ───────────────
      // At 120 BPM a bar is 2 s: `w20.low` spans 0-8 s, `w20.high` spans 4-12 s,
      // so they overlap on 4-8 s and the midpoint of the overlap is 6 s.
      //
      // A LINEAR crossfade of two uncorrelated tones loses ~3 dB there (two 0.5
      // gains sum to 0.5 of the power of one solo tone). The default curve is
      // "equal", so the summed power across the overlap must stay near the solo
      // power. That is the objective's §5 claim, measured rather than asserted.
      const lowId = withLowAndHigh.arrangement.audioClips?.find(
        (c: { bufferId: string }) => c.bufferId === "w20.low",
      )?.id;
      const highId = withLowAndHigh.arrangement.audioClips?.find(
        (c: { bufferId: string }) => c.bufferId === "w20.high",
      )?.id;
      if (!lowId || !highId) throw new Error("crossfade fixture lost its clips");

      // Solo reference: the same source rendered on its own across the overlap.
      const soloLow = addAudioClip(bare, track.id, "w20.low", 0, 4).execute(bare);
      const soloRender = await render(soloLow);
      out.soloOverlapLow = amplitudeAt(soloRender, 220, 5.6);
      out.soloOverlapHigh = amplitudeAt(soloRender, 550, 5.6);

      // The pair BEFORE the crossfade: both clips already overlap, each at full
      // gain, so this is the "no dip possible" upper reference.
      const xfBefore = await render(withLowAndHigh);
      out.preCrossfadeLow = amplitudeAt(xfBefore, 220, 5.6);
      out.preCrossfadeHigh = amplitudeAt(xfBefore, 550, 5.6);

      const crossfaded = crossfadeAudioClips(withLowAndHigh, lowId, highId).execute(withLowAndHigh);
      const xfRender = await render(crossfaded);
      out.crossfadeLow = amplitudeAt(xfRender, 220, 5.6);
      out.crossfadeHigh = amplitudeAt(xfRender, 550, 5.6);
      const xfClips = (crossfaded.arrangement.audioClips ?? []) as Array<{
        bufferId: string;
        fadeIn: number;
        fadeOut: number;
        fadeCurve?: string;
      }>;
      out.crossfadeFades = xfClips.map((c) => [c.bufferId, c.fadeIn, c.fadeOut]);
      out.crossfadeCurves = xfClips.map((c) => c.fadeCurve ?? null);
      // Direction-safe: swapping the arguments must produce the same audio.
      const crossfadedSwapped = crossfadeAudioClips(withLowAndHigh, highId, lowId).execute(withLowAndHigh);
      const xfSwapped = await render(crossfadedSwapped);
      out.crossfadeSwappedLow = amplitudeAt(xfSwapped, 220, 5.6);
      out.crossfadeSwappedHigh = amplitudeAt(xfSwapped, 550, 5.6);

      return out;
    });

    // ── CONTROL ────────────────────────────────────────────────────────────
    // If these fail, nothing below measures anything: a fixture that rendered
    // nothing would satisfy every "tone is absent" assertion in this file.
    expect(report.baselineLowEarly as number).toBeGreaterThan(0.05);
    expect(report.baselineLowLate as number).toBeGreaterThan(0.05);
    expect(report.baselineHighEarly as number, "w20.high must not sound before bar 2").toBeLessThan(0.005);
    expect(report.baselineHighLate as number).toBeGreaterThan(0.05);

    // ── MUTE: silent, not quieter; and only the muted clip ──────────────────
    // CONTROL on this section: the same clip measured loud a moment earlier.
    expect(report.unmutedLateRms as number, "the mute fixture's clip was already silent").toBeGreaterThan(0.05);
    expect(report.muteLateHigh as number, "a muted clip is still audible in the render").toBeLessThan(0.005);
    expect(report.muteLateRms as number, "muted clip left energy in the render").toBeLessThan(0.01);
    expect(report.muteEarlyRms as number, "mute silenced the UNMUTED neighbour").toBeGreaterThan(0.05);

    // ── SLIP: same position, different source material ─────────────────────
    // The unslipped ramp is 220 Hz at t=0.5 s; slipped by 2 s it is hearing
    // t=2.5 s, which is the 550 Hz half. Position and length must not move.
    expect(report.slipBeforeLow as number).toBeGreaterThan(0.05);
    expect(report.slipBeforeHigh as number).toBeLessThan(0.005);
    expect(report.slipAfterHigh as number, "slip did not change which source is heard").toBeGreaterThan(0.05);
    expect(report.slipAfterLow as number).toBeLessThan(0.005);
    expect(report.slipStartBar as number, "slip moved the clip (that is a move, not a slip)").toBe(0);
    expect(report.slipLengthBars as number, "slip changed the length (that is a resize, not a slip)").toBe(4);
    expect(report.slipOffsetSec as number).toBeCloseTo(2, 6);

    // ── STRETCH: longer clip, slower playback, pitch shifted by the resample ─
    expect(report.stretchLengthBars as number).toBe(8);
    expect(report.stretchRate as number).toBe(0.5);
    // The unstretched control really is 220 Hz, so the 220 -> 110 Hz move below
    // is caused by the stretch and not by the fixture's own frequency.
    expect(report.unstretchedEarlyLow as number).toBeGreaterThan(0.05);
    expect(report.stretchEarlyShifted as number, "the stretched clip rendered silence").toBeGreaterThan(0.05);
    // Documented consequence: `stretchRate` resamples, so it shifts pitch down.
    // This is a real user-facing property of the verb, not an artefact.
    expect(report.stretchEarlyLow as number, "stretching did not shift the resample rate").toBeLessThan(0.005);

    // ── SLICE: a "clip row" APPENDED after the original, not an in-place cut ──
    // CORRECTED FROM A WRONG ASSUMPTION, and the correction is the finding.
    // I assumed slicing rewrote the clip in place and asserted contiguity. The
    // measured geometry is: original clip at bar 0 with length 4 bars, and the
    // next fragment at bar 4.5. The command KEEPS the original
    // (`[...(doc.arrangement.audioClips ?? []), ...newClips]`) and lays the
    // segments out as a ROW after it, starting half a bar past the original's
    // end and stepping by (segment + 0.25 bar) — which is what the command's own
    // docstring means by "SlicerX/PT-style: transient -> clip row".
    const geometry = report.sliceGeometry as Array<[number, number]>;
    const geometryJson = JSON.stringify(geometry);
    const sorted = [...geometry].sort((a, b) => a[0] - b[0]);
    // 1 original + 3 segments from 2 slice points inside an 8 s clip.
    expect(report.sliceCount as number, `slice geometry=${geometryJson}`).toBe(4);
    // The original survives, untouched, at its own position.
    expect(sorted[0], `the source clip was not preserved: ${geometryJson}`).toEqual([0, 4]);
    // The row starts half a bar after the original ends, then steps by
    // (segment length + 0.25 bar).
    const row = sorted.slice(1);
    expect(row[0]![0], `row does not start at originalEnd + 0.5: ${geometryJson}`).toBeCloseTo(4.5, 6);
    for (let i = 1; i < row.length; i++) {
      expect(row[i]![0], `row spacing is wrong at ${i}: ${geometryJson}`).toBeCloseTo(
        row[i - 1]![0] + row[i - 1]![1] + 0.25,
        6,
      );
    }
    // D1: a slice is much shorter than its parent, so the parent's fades must be
    // re-bounded by the SEGMENT's own length, not the parent's.
    expect(report.sliceFadeOvershoot as number, `a segment carries a fade longer than itself: ${geometryJson}`).toBe(0);
    // The segments really do render.
    expect(report.sliceRmsMid as number, "the sliced segments rendered silence").toBeGreaterThan(0.05);
    // Segment material is conserved: the segments together span the parent.
    const segmentBars = row.reduce((sum, [, len]) => sum + len, 0);
    expect(segmentBars, `slice did not conserve source length: ${geometryJson}`).toBeGreaterThan(3.5);

    // ── STRIP SILENCE: only the requested segments survive ─────────────────
    expect(report.stripCount as number).toBe(2);
    expect(report.stripFirstLow as number, "the first kept segment (0-1 s, 220 Hz) is missing").toBeGreaterThan(0.05);
    expect(report.stripFirstHigh as number).toBeLessThan(0.005);

    // ── CROSSFADE: equal power, so the overlap must NOT dip ───────────────
    // Both tones are present through the crossfade.
    expect(report.crossfadeLow as number).toBeGreaterThan(0.05);
    expect(report.crossfadeHigh as number).toBeGreaterThan(0.05);
    // Equal power: combined energy >= 80% of a solo tone's energy at the same
    // point. A linear crossfade would land near 50% and fail here.
    const crossfadePower = (report.crossfadeLow as number) ** 2 + (report.crossfadeHigh as number) ** 2;
    const soloPower = (report.soloOverlapLow as number) ** 2;
    expect(crossfadePower, "the crossfade dipped in the overlap (linear, not equal-power)").toBeGreaterThan(
      soloPower * 0.8,
    );
    // The fades were actually written, and both clips got the equal curve.
    const fades = report.crossfadeFades as Array<[string, number, number]>;
    expect(fades.find(([id]) => id === "w20.low")?.[2]).toBeGreaterThan(0);
    expect(fades.find(([id]) => id === "w20.high")?.[1]).toBeGreaterThan(0);
    expect(report.crossfadeCurves).toEqual(["equal", "equal"]);
    // Direction-safe in the AUDIO, not just the document.
    expect(report.crossfadeSwappedLow as number).toBeCloseTo(report.crossfadeLow as number, 4);
    expect(report.crossfadeSwappedHigh as number).toBeCloseTo(report.crossfadeHigh as number, 4);
  });

  /**
   * Two gaps the first test did not close, both recorded rather than glossed:
   *
   *  1. **Consolidate was missing.** The wave-20 report said "7 verbs
   *     render-verified", but the first version of this spec contained six.
   *     Consolidate appears here so the number and the coverage agree.
   *
   *  2. **Live-path parity was declared NOT VERIFIED** at the end of wave 20.
   *     Offline-only is exactly the "code presence mistaken for proven
   *     functionality" the audit keeps warning about, so the live scheduler is
   *     driven here through an OfflineAudioContext standing in for the live
   *     context (the pattern spec 12 uses) and compared sample-for-sample
   *     against the offline render.
   */
  test("consolidate merges clips in the render, and the live path matches the offline one", async ({ page }) => {
    test.setTimeout(180_000);
    await openHouseTemplate(page);

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, rendererModule, engineModule, workletModule, takesModule] =
        await Promise.all([
          load("/src/project-model/templates.ts"),
          load("/src/commands/commands.ts"),
          load("/src/sample-library/factory.ts"),
          load("/src/rendering/renderer.ts"),
          load("/src/audio-engine/AudioEngine.ts"),
          load("/src/audio-worklets/loader.ts"),
          load("/src/project-model/audio-takes.ts"),
        ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, consolidateAudioClips, slipAudioClip, stretchAudioClip, crossfadeAudioClips } =
        commandModule;
      const { SampleBank } = sampleModule;
      const { renderProject } = rendererModule;
      const { AudioEngine } = engineModule;
      const { ensureWorkletsForDoc } = workletModule;
      const { audioClipsForPlayback } = takesModule;

      const sampleRate = 44_100;
      const TONE_SECONDS = 16; // consolidate produces an 8-bar span = 16 s
      const makeTone = (frequency: number): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, sampleRate * TONE_SECONDS, sampleRate).createBuffer(
          1,
          sampleRate * TONE_SECONDS,
          sampleRate,
        );
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          samples[frame] = 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
        }
        return buffer;
      };
      const bank = new SampleBank();
      // 330 Hz is deliberately different from the 220/550 pair in the first
      // test: the consolidated clip must be provably the clip we created, not
      // an echo of a tone measured by the other spec.
      bank.add("w20.mid", makeTone(330));
      bank.add("w20.low", makeTone(220));
      bank.add("w20.high", makeTone(550));

      const template = createProjectFromTemplate("empty");
      const track = template.tracks[0];
      if (!track) throw new Error("empty-project audio track fixture missing");
      const bare = { ...template, arrangement: { ...template.arrangement, clips: [], audioClips: [] } };

      const amplitudeAt = (buffer: AudioBuffer, frequency: number, startSec: number, windowSec = 0.35): number => {
        const samples = buffer.getChannelData(0);
        const start = Math.round(sampleRate * startSec);
        const count = Math.round(sampleRate * windowSec);
        let real = 0;
        let imaginary = 0;
        for (let index = 0; index < count; index++) {
          const sample = samples[start + index] ?? 0;
          const phase = (2 * Math.PI * frequency * index) / sampleRate;
          real += sample * Math.cos(phase);
          imaginary -= sample * Math.sin(phase);
        }
        return (2 * Math.hypot(real, imaginary)) / count;
      };

      /** Render a project through the LIVE scheduler path, for parity. */
      const renderLive = async (project: ProjectDocument, lengthFrames: number) => {
        const liveContext = new OfflineAudioContext(2, lengthFrames, sampleRate);
        await ensureWorkletsForDoc(project, liveContext);
        const engine = new AudioEngine();
        engine.attachBank(bank);
        engine.useContext(liveContext);
        engine.setProject(project);
        // 120 BPM => 2 s per bar, which is why startBar * 2 is the wall time.
        for (const clip of audioClipsForPlayback(project.arrangement)) {
          engine.triggerAudioClip(clip, clip.startBar * 2, clip.lengthBars * 2);
        }
        const rendered = await liveContext.startRendering();
        engine.detachBank();
        return rendered;
      };
      const maxAbsDiff = (a: AudioBuffer, b: AudioBuffer): number => {
        const left = a.getChannelData(0);
        const right = b.getChannelData(0);
        const count = Math.min(left.length, right.length);
        let worst = 0;
        for (let frame = 0; frame < count; frame++) {
          worst = Math.max(worst, Math.abs((left[frame] ?? 0) - (right[frame] ?? 0)));
        }
        return worst;
      };

      const render = async (project: ProjectDocument) =>
        renderProject(project, bank, { mode: "song", sampleRate, tailSeconds: 0 });

      const out: Record<string, unknown> = {};

      // ── CONSOLIDATE: two 4-bar clips of one source -> one 8-bar clip ──────
      const pairA = addAudioClip(bare, track.id, "w20.mid", 0, 4).execute(bare);
      const pairB = addAudioClip(pairA, track.id, "w20.mid", 4, 4).execute(pairA);
      const pairIds = (pairB.arrangement.audioClips ?? []).map((c: { id: string }) => c.id);
      out.pairCount = pairIds.length;

      // The consolidated clip points at a NEW buffer id, so the rendered result
      // of the pair is registered in the bank first - exactly what the real
      // consolidate flow does when it hands back a bounce buffer.
      const pairRender = await render(pairB);
      bank.add("w20.consolidated", pairRender);

      const consolidated = consolidateAudioClips(pairB, pairIds, "w20.consolidated").execute(pairB);
      const merged = (consolidated.arrangement.audioClips ?? []) as Array<{
        startBar: number;
        lengthBars: number;
        bufferId: string;
      }>;
      out.mergedCount = merged.length;
      out.mergedGeometry = merged.map((c) => [c.startBar, c.lengthBars]);
      out.mergedBufferId = merged[0]?.bufferId;
      const mergedRender = await render(consolidated);
      // Audible across the WHOLE merged span, not just where one input was.
      out.mergedEarlyMid = amplitudeAt(mergedRender, 330, 1.5);
      out.mergedLateMid = amplitudeAt(mergedRender, 330, 12);
      // The untouched pair renders the same tone over the same span, which is
      // what makes the merged render comparable rather than merely non-silent.
      out.pairEarlyMid = amplitudeAt(pairRender, 330, 1.5);
      out.pairLateMid = amplitudeAt(pairRender, 330, 12);
      // Diagnostic sweep: where exactly does the merged clip stop sounding, and
      // how long is each render? Speculating about the cause was not converging,
      // so this measures. The sweep times are printed in the failure message.
      const SWEEP = [0.5, 3, 6, 7, 7.5, 8, 9, 10, 12];
      out.mergedDurationSec = mergedRender.duration;
      out.pairDurationSec = pairRender.duration;
      out.mergedSweep = SWEEP.map((t) => amplitudeAt(mergedRender, 330, t));
      out.pairSweep = SWEEP.map((t) => amplitudeAt(pairRender, 330, t));

      // ── LIVE vs OFFLINE, on the crossfaded pair and the consolidated clip ──
      const overlapA = addAudioClip(bare, track.id, "w20.low", 0, 6).execute(bare);
      const overlapB = addAudioClip(overlapA, track.id, "w20.high", 2, 4).execute(overlapA);
      const [overlapLowId, overlapHighId] = (overlapB.arrangement.audioClips ?? []).map((c: { id: string }) => c.id);
      const crossfaded = crossfadeAudioClips(overlapB, overlapLowId!, overlapHighId!).execute(overlapB);

      const xfOffline = await render(crossfaded);
      const xfLive = await renderLive(crossfaded, xfOffline.length);
      out.crossfadeOfflineVsLive = maxAbsDiff(xfOffline, xfLive);
      out.crossfadeOfflineLow = amplitudeAt(xfOffline, 220, 5.6);
      out.crossfadeLiveLow = amplitudeAt(xfLive, 220, 5.6);
      out.crossfadeLiveHigh = amplitudeAt(xfLive, 550, 5.6);

      // A slitted clip: the live path must schedule every fragment.
      const toSlip = addAudioClip(bare, track.id, "w20.low", 0, 4).execute(bare);
      const slipId = toSlip.arrangement.audioClips?.[0]?.id;
      const slipped = slipAudioClip(toSlip, slipId!, 2).execute(toSlip);
      const slippedOffline = await render(slipped);
      const slippedLive = await renderLive(slipped, slippedOffline.length);
      out.slipOfflineVsLive = maxAbsDiff(slippedOffline, slippedLive);

      // A stretched clip: rate handling differs most between the two paths.
      const toStretch = addAudioClip(bare, track.id, "w20.low", 0, 4).execute(bare);
      const stretchId = toStretch.arrangement.audioClips?.[0]?.id;
      const stretched = stretchAudioClip(toStretch, stretchId!, 8, 0.5).execute(toStretch);
      const stretchOffline = await render(stretched);
      const stretchLive = await renderLive(stretched, stretchOffline.length);
      out.stretchOfflineVsLive = maxAbsDiff(stretchOffline, stretchLive);
      out.stretchLiveShifted = amplitudeAt(stretchLive, 110, 0.5);

      return out;
    });

    // ── CONSOLIDATE ───────────────────────────────────────────────────────
    expect(report.pairCount as number).toBe(2);
    expect(report.mergedCount as number, `consolidate left ${report.mergedCount} clips`).toBe(1);
    // One clip spanning the union of the two 4-bar inputs = 8 bars at bar 0.
    expect(report.mergedGeometry, `merged geometry=${JSON.stringify(report.mergedGeometry)}`).toEqual([[0, 8]]);
    expect(report.mergedBufferId as string).toBe("w20.consolidated");
    // CONTROL: the inputs really did sound across the whole span.
    expect(report.pairEarlyMid as number).toBeGreaterThan(0.05);
    expect(report.pairLateMid as number, "the second input never sounded").toBeGreaterThan(0.05);
    // ...and so does the merged clip.
    expect(report.mergedEarlyMid as number, "the consolidated clip is silent at the start").toBeGreaterThan(0.05);
    expect(
      report.mergedLateMid as number,
      `merged silent at 12 s | mergedDur=${report.mergedDurationSec} pairDur=${report.pairDurationSec} ` +
        `mergedSweep=${JSON.stringify(report.mergedSweep)} pairSweep=${JSON.stringify(report.pairSweep)}`,
    ).toBeGreaterThan(0.05);

    // ── LIVE vs OFFLINE ───────────────────────────────────────────────────
    // The live path must reproduce the crossfade, including both tones and the
    // equal-power shape. A zero difference is NOT required (the two paths
    // schedule differently); a small one is. These thresholds are calibrated
    // against the offline render, not chosen to be safe.
    expect(report.crossfadeOfflineLow as number).toBeGreaterThan(0.05);
    expect(report.crossfadeLiveLow as number, "live playback lost the low tone").toBeGreaterThan(0.05);
    expect(report.crossfadeLiveHigh as number, "live playback lost the high tone").toBeGreaterThan(0.05);
    expect(report.crossfadeOfflineVsLive as number, "live and offline crossfades diverge").toBeLessThan(0.05);
    expect(report.slipOfflineVsLive as number, "live and offline slips diverge").toBeLessThan(0.05);
    expect(report.stretchOfflineVsLive as number, "live and offline stretches diverge").toBeLessThan(0.05);
    // The stretch's pitch shift must be present live too, not just offline.
    expect(report.stretchLiveShifted as number, "live playback did not apply the stretch rate").toBeGreaterThan(0.05);
  });
});
