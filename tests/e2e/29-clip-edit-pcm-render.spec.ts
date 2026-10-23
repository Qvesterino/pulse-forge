import { expect, test } from "playwright/test";
import type { ProjectDocument } from "../../src/project-model/types";
import { openHouseTemplate } from "./_helpers";

/**
 * WAVE 29 — PCM-level render assertions for the edit verbs wave 20 left open.
 *
 * WHY THIS WAVE EXISTS, stated plainly: wave 20 proved the RENDERED audio of
 * mute, slip, stretch, slice, strip-silence, crossfade and consolidate. The
 * verbs it did NOT touch — trim start, resize, move, split, reverse, gain,
 * loop and duplicate/paste — were verified only at the DOCUMENT level by the
 * wave-3 matrices (`tests/clip-edit-matrix.test.ts` and friends). A document
 * can be perfectly correct and still render the wrong audio: the trim may
 * advance the source twice, the resize may re-read the sample from its head,
 * the split may restart the right fragment at zero, the duplicate may drop
 * the source offset. None of those are visible in the document's shape.
 *
 * METHOD: a real Chromium, a real `OfflineAudioContext`, the same
 * `renderProject(doc, SampleBank, ...)` the export path uses, and a
 * Goertzel-style single-frequency probe.
 *
 * THE SOURCE IS A STAIRCASE, NOT A TONE. Every 2 s of source is a different
 * frequency (220 / 440 / 660 / 880 / 1100 / 1320 / 1540 / 1760 Hz), so a
 * probe can name the SOURCE POSITION that is audible, not merely that
 * "something is there". That is what separates the verbs from each other:
 *
 *   - a MOVE relocates the clip and keeps the source position,
 *   - a TRIM START advances the source by the same amount it moves the head,
 *   - a SPLIT advances the source of the right fragment by the left half,
 *   - a REVERSE plays the source backwards (the head becomes the tail),
 *   - a DUPLICATE carries the source position of its original.
 *
 * A pure tone cannot tell any of those apart — they all sound like "still
 * 220 Hz".
 *
 * EVERY "ABSENCE" ASSERTION HAS A MEASURED CONTROL. A claim like "the head
 * region is silent after the move" is only meaningful next to a measured
 * "the head region was audible before the move". Each control below is
 * rendered from the SAME document the verb started from, not assumed.
 */

/**
 * The staircase's segment frequencies — source seconds [i*2, (i+1)*2). It is
 * declared INSIDE each page.evaluate, because the evaluate body is
 * serialized and re-parsed in the browser: a module-scope const would not be
 * in scope there.
 */

test.describe("29 — clip-edit PCM render assertions", () => {
  // WebKit on Windows has no Web Audio media stack — same reason as spec 20.
  test.skip(({ browserName }) => browserName !== "chromium", "WebKit on Windows has no Web Audio media stack");

  test("each remaining edit verb changes the RENDERED audio, not just the document", async ({ page }) => {
    test.setTimeout(300_000);
    await openHouseTemplate(page);

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, rendererModule, schemaModule] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/rendering/renderer.ts"),
        load("/src/project-model/schema.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const {
        addAudioClip,
        trimAudioClipStart,
        resizeAudioClip,
        moveAudioClip,
        updateAudioClip,
        splitAudioClipAtTick,
        duplicateAudioClip,
        buildClipClipboard,
        pasteClips,
      } = commandModule;
      const { SampleBank } = sampleModule;
      const { renderProject } = rendererModule;
      const { ticksPerBar } = schemaModule;

      const sampleRate = 44_100;
      // The empty template runs at 120 BPM, so ONE BAR = 2 s. The staircase's
      // segment length is the same 2 s, which is what lets a probe name the
      // source position without an off-by-one bar ever creeping in.
      const BAR_SEC = 2;
      const TONE_SECONDS = 16;
      const STAIR = [220, 440, 660, 880, 1100, 1320, 1540, 1760];

      /** The staircase: 2 s of one frequency, then 2 s of the next. */
      const makeStair = (): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, sampleRate * TONE_SECONDS, sampleRate).createBuffer(
          1,
          sampleRate * TONE_SECONDS,
          sampleRate,
        );
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          const t = frame / sampleRate;
          const segment = Math.min(STAIR.length - 1, Math.floor(t / BAR_SEC));
          // The phase restarts at every segment boundary, so each segment is a
          // clean sine with no click at the seam.
          const local = t - segment * BAR_SEC;
          samples[frame] = 0.2 * Math.sin(2 * Math.PI * STAIR[segment] * local);
        }
        return buffer;
      };

      /** A 2 s source: 440 Hz for the first second, 880 Hz for the second. */
      const makeLoopPair = (): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, sampleRate * 2, sampleRate).createBuffer(1, sampleRate * 2, sampleRate);
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          const t = frame / sampleRate;
          const frequency = t < 1 ? 440 : 880;
          samples[frame] = 0.2 * Math.sin(2 * Math.PI * frequency * (t < 1 ? t : t - 1));
        }
        return buffer;
      };

      const bank = new SampleBank();
      bank.add("w29.stair", makeStair());
      bank.add("w29.loop2", makeLoopPair());

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

      const render = async (project: ProjectDocument) =>
        renderProject(project, bank, { mode: "song", sampleRate, tailSeconds: 0 });

      const out: Record<string, unknown> = {};

      // ── FIXTURE + CONTROL ────────────────────────────────────────────────
      // ONE base document and ONE control render serve trim / resize / move /
      // split / reverse / gain: they are all edits of the same starting state,
      // so re-rendering it per verb would measure the same thing six times.
      const base = addAudioClip(bare, track.id, "w29.stair", 0, 4).execute(bare);
      const baseClip = base.arrangement.audioClips?.[0];
      if (!baseClip) throw new Error("staircase fixture lost its clip");
      const baseId = baseClip.id;
      const baseRender = await render(base);
      out.baseDurationSec = baseRender.duration;

      // CONTROL: the staircase is audible, and the probe can name the segment.
      out.baseHead220 = amplitudeAt(baseRender, 220, 0.5);
      out.baseHead440 = amplitudeAt(baseRender, 440, 0.5);
      out.baseSeg1 = amplitudeAt(baseRender, 440, 2.5);
      out.baseSeg2 = amplitudeAt(baseRender, 660, 4.5);
      out.baseSeg3 = amplitudeAt(baseRender, 880, 6.5);

      // ── TRIM START ───────────────────────────────────────────────────────
      // The arrangement panel's rule: the trim advances `offsetSec` ONLY and
      // leaves `trimStart` riding, because the audible source start is
      // `offsetSec + trimStart` and advancing both counted the skip twice.
      // The gesture moves the head right by 2 s of wall time and skips 2 s of
      // source, so the material at the clip's OWN head is 2 s deeper.
      const trimmed = trimAudioClipStart(base, baseId, {
        startBar: 1,
        lengthBars: 3,
        trimStart: baseClip.trimStart ?? 0,
        offsetSec: (baseClip.offsetSec ?? 0) + 2,
      }).execute(base);
      const trimRender = await render(trimmed);
      out.trimHead = amplitudeAt(trimRender, 440, 2.5); // new head → source 2.5 s → 440 Hz
      out.trimHeadOldMaterial = amplitudeAt(trimRender, 220, 2.5);
      out.trimVacated = amplitudeAt(trimRender, 220, 0.5); // the old head is now silent
      out.trimVacatedControl = amplitudeAt(baseRender, 220, 0.5); // …it was audible
      const trimClip = trimmed.arrangement.audioClips?.[0];
      out.trimStartBar = trimClip?.startBar;
      out.trimLengthBars = trimClip?.lengthBars;
      out.trimOffsetSec = trimClip?.offsetSec;
      out.trimEndBar = (trimClip?.startBar ?? 0) + (trimClip?.lengthBars ?? 0);

      // ── RESIZE ───────────────────────────────────────────────────────────
      // Shrinking must cut the TAIL and keep the head; growing must pull NEW
      // material out of the sample, not repeat the head.
      const shrunk = resizeAudioClip(base, baseId, 2).execute(base);
      const shrinkRender = await render(shrunk);
      out.resizeHeadKept = amplitudeAt(shrinkRender, 220, 0.5);
      out.resizeTailGone = amplitudeAt(shrinkRender, 660, 4.5);
      out.resizeTailControl = amplitudeAt(baseRender, 660, 4.5); // …the tail WAS there
      out.resizeLengthBars = shrunk.arrangement.audioClips?.[0]?.lengthBars;

      const grown = resizeAudioClip(base, baseId, 6).execute(base);
      const growRender = await render(grown);
      out.growTailNew = amplitudeAt(growRender, 1320, 10.5); // source 10.5 s → 1320 Hz
      out.growTailControl = amplitudeAt(baseRender, 1320, 10.5); // …nothing there before
      out.growLengthBars = grown.arrangement.audioClips?.[0]?.lengthBars;
      out.growDurationSec = growRender.duration;

      // ── MOVE ─────────────────────────────────────────────────────────────
      // A move relocates the clip and NOTHING else: the source position rides
      // along, so the head still sounds what it always sounded.
      const moved = moveAudioClip(base, baseId, 4).execute(base);
      const moveRender = await render(moved);
      out.moveVacated = amplitudeAt(moveRender, 220, 0.5);
      out.moveVacatedControl = amplitudeAt(baseRender, 220, 0.5); // …it was audible
      out.moveNewPlace = amplitudeAt(moveRender, 220, 8.5); // the head material is UNCHANGED
      out.moveNewPlaceAdvanced = amplitudeAt(moveRender, 1100, 8.5); // a move must NOT advance the source
      out.moveStartBar = moved.arrangement.audioClips?.[0]?.startBar;
      out.moveOffsetSec = moved.arrangement.audioClips?.[0]?.offsetSec;
      out.moveDurationSec = moveRender.duration;

      // ── SPLIT ────────────────────────────────────────────────────────────
      // The split is audio-NEUTRAL: the two fragments together sound exactly
      // what the original sounded. The right fragment must therefore CONTINUE
      // at source 4.5 s (660 Hz) — a fragment that restarted at zero would
      // sound 220 Hz there and the seam would repeat the head.
      const splitTick = 2 * ticksPerBar(base);
      const split = splitAudioClipAtTick(base, baseId, splitTick).execute(base);
      const splitRender = await render(split);
      out.splitCount = split.arrangement.audioClips?.length;
      out.splitLeft = amplitudeAt(splitRender, 220, 0.5);
      out.splitRight = amplitudeAt(splitRender, 660, 4.5);
      out.splitRightRestarted = amplitudeAt(splitRender, 220, 4.5);
      out.splitControl = amplitudeAt(baseRender, 660, 4.5); // the unsplit clip was already 660 there
      const splitClips = split.arrangement.audioClips ?? [];
      const splitRight = splitClips.find((c: { startBar?: number }) => (c.startBar ?? 0) > 0);
      out.splitRightStartBar = splitRight?.startBar;
      out.splitRightOffsetSec = splitRight?.offsetSec;

      // ── REVERSE ──────────────────────────────────────────────────────────
      // Reverse plays the source backwards, so the clip's head becomes the
      // source's tail: the head frequency and the tail frequency SWAP.
      const reversed = updateAudioClip(base, baseId, { reverse: true }).execute(base);
      const reverseRender = await render(reversed);
      out.reverseHead = amplitudeAt(reverseRender, 880, 0.5); // source 7.5 s → 880 Hz
      out.reverseTail = amplitudeAt(reverseRender, 220, 6.5); // source 1.5 s → 220 Hz
      out.reverseHeadControl = amplitudeAt(baseRender, 220, 0.5);
      out.reverseTailControl = amplitudeAt(baseRender, 880, 6.5);
      out.reverseHeadOld = amplitudeAt(reverseRender, 220, 0.5);
      out.reverseTailOld = amplitudeAt(reverseRender, 880, 6.5);
      out.reverseFlag = reversed.arrangement.audioClips?.[0]?.reverse;

      // ── GAIN ─────────────────────────────────────────────────────────────
      const gained = updateAudioClip(base, baseId, { gain: 0.25 }).execute(base);
      const gainRender = await render(gained);
      out.gainBefore = amplitudeAt(baseRender, 220, 0.5);
      out.gainAfter = amplitudeAt(gainRender, 220, 0.5);
      out.gainWrongFrequency = amplitudeAt(gainRender, 440, 0.5); // the source itself is unchanged

      // ── LOOP ─────────────────────────────────────────────────────────────
      // A 2 s source under an 8 s clip. Without the loop the source is
      // exhausted after 2 s; with it the source repeats, and the PHASE
      // repeats with it — the tail must be 440 Hz where the head was 440 Hz
      // and 880 Hz where the head's second half was.
      const loopBase = addAudioClip(bare, track.id, "w29.loop2", 0, 4).execute(bare);
      const loopId = loopBase.arrangement.audioClips?.[0]?.id;
      if (!loopId) throw new Error("loop fixture lost its clip");
      const loopControl = await render(loopBase);
      const looped = updateAudioClip(loopBase, loopId, { loop: true }).execute(loopBase);
      const loopRender = await render(looped);
      out.loopHead = amplitudeAt(loopRender, 440, 0.5);
      out.loopSecond = amplitudeAt(loopRender, 880, 1.5);
      out.loopTail = amplitudeAt(loopRender, 440, 6.5);
      out.loopTailSecond = amplitudeAt(loopRender, 880, 7.5);
      out.loopTailControl = amplitudeAt(loopControl, 440, 6.5); // …nothing there before
      out.loopTailControlSecond = amplitudeAt(loopControl, 880, 6.5);
      out.loopFlag = looped.arrangement.audioClips?.[0]?.loop;

      // ── DUPLICATE ────────────────────────────────────────────────────────
      // The clip starts 4 s INTO the staircase, so a copy that kept the
      // source position sounds 660 Hz and a copy that reset it sounds 220 Hz.
      const offsetBase = addAudioClip(bare, track.id, "w29.stair", 0, 4, { offsetSec: 4 }).execute(bare);
      const offsetId = offsetBase.arrangement.audioClips?.[0]?.id;
      if (!offsetId) throw new Error("duplicate fixture lost its clip");
      const offsetControl = await render(offsetBase);
      const duplicated = duplicateAudioClip(offsetBase, offsetId).execute(offsetBase);
      const dupRender = await render(duplicated);
      out.dupOriginal = amplitudeAt(dupRender, 660, 0.5);
      out.dupCopy = amplitudeAt(dupRender, 660, 8.5);
      out.dupCopyReset = amplitudeAt(dupRender, 220, 8.5);
      out.dupCopyControl = amplitudeAt(offsetControl, 220, 8.5); // …nothing there before
      out.dupCount = duplicated.arrangement.audioClips?.length;
      const dupClips = duplicated.arrangement.audioClips ?? [];
      const dupCopy = dupClips.find((c: { startBar?: number }) => (c.startBar ?? 0) > 0);
      out.dupCopyOffsetSec = dupCopy?.offsetSec;
      out.dupCopyGain = dupCopy?.gain;

      // ── PASTE ────────────────────────────────────────────────────────────
      // The clipboard payload keeps the source position too, and the paste
      // lands the copy at the playhead (bar 8 → wall 16 s).
      const clipboard = buildClipClipboard(offsetBase, [offsetId]);
      const pasted = pasteClips(offsetBase, clipboard, 8 * ticksPerBar(offsetBase)).execute(offsetBase);
      const pasteRender = await render(pasted);
      out.pasteCount = pasted.arrangement.audioClips?.length;
      out.pasteHead = amplitudeAt(pasteRender, 660, 16.5);
      out.pasteHeadReset = amplitudeAt(pasteRender, 220, 16.5);
      out.pasteHeadControl = amplitudeAt(offsetControl, 220, 16.5); // …nothing there before
      out.pasteCopyOffsetSec = (pasted.arrangement.audioClips ?? []).find((c: { startBar?: number }) => (c.startBar ?? 0) >= 8)
        ?.offsetSec;

      return out;
    });

    // ── CONTROL ────────────────────────────────────────────────────────────
    // If these fail, nothing below measures anything: a fixture that rendered
    // nothing would satisfy every "tone is absent" assertion in this file.
    expect(report.baseDurationSec as number, "the base render is not the length of the clip").toBeCloseTo(8, 1);
    expect(report.baseHead220 as number, "the staircase is not audible at the clip's head").toBeGreaterThan(0.05);
    expect(report.baseHead440 as number, "the probe cannot tell the segments apart").toBeLessThan(0.005);
    expect(report.baseSeg1 as number).toBeGreaterThan(0.05);
    expect(report.baseSeg2 as number).toBeGreaterThan(0.05);
    expect(report.baseSeg3 as number).toBeGreaterThan(0.05);

    // ── TRIM START ────────────────────────────────────────────────────────
    expect(report.trimHead as number, "the trim did not advance the source").toBeGreaterThan(0.05);
    expect(report.trimHeadOldMaterial as number, "the trimmed head still plays the old material").toBeLessThan(0.005);
    expect(report.trimVacatedControl as number, "the vacated head was never audible").toBeGreaterThan(0.05);
    expect(report.trimVacated as number, "the trim left the old head region audible").toBeLessThan(0.005);
    expect(report.trimStartBar as number).toBe(1);
    expect(report.trimLengthBars as number).toBe(3);
    expect(report.trimOffsetSec as number, "the trim advanced the source by the wrong amount").toBeCloseTo(2, 6);
    // The end edge is the anchor of the trim gesture — it must not move.
    expect(report.trimEndBar as number, "the trim moved the clip's end edge").toBe(4);

    // ── RESIZE ────────────────────────────────────────────────────────────
    expect(report.resizeHeadKept as number, "the resize threw the head away").toBeGreaterThan(0.05);
    expect(report.resizeTailControl as number, "the resize fixture never had a tail").toBeGreaterThan(0.05);
    expect(report.resizeTailGone as number, "the resize left the tail audible").toBeLessThan(0.005);
    expect(report.resizeLengthBars as number).toBe(2);
    // Growing pulls NEW material out of the sample instead of repeating the head.
    expect(report.growTailControl as number, "the grow fixture never had that tail").toBeLessThan(0.005);
    expect(report.growTailNew as number, "the grown clip did not play new material").toBeGreaterThan(0.05);
    expect(report.growLengthBars as number).toBe(6);
    expect(report.growDurationSec as number, "the grown render is too short for the probe").toBeGreaterThan(11);

    // ── MOVE ──────────────────────────────────────────────────────────────
    expect(report.moveVacatedControl as number, "the move fixture never occupied the head").toBeGreaterThan(0.05);
    expect(report.moveVacated as number, "the move left the old place audible").toBeLessThan(0.005);
    expect(report.moveNewPlace as number, "the moved clip is silent at its new place").toBeGreaterThan(0.05);
    expect(report.moveNewPlaceAdvanced as number, "the move advanced the source (that is a trim)").toBeLessThan(0.005);
    expect(report.moveStartBar as number).toBe(4);
    expect(report.moveOffsetSec as number, "the move changed the source position").toBe(0);
    expect(report.moveDurationSec as number, "the moved render is too short for the probe").toBeGreaterThan(9);

    // ── SPLIT ─────────────────────────────────────────────────────────────
    expect(report.splitCount as number, "the split did not produce two fragments").toBe(2);
    expect(report.splitLeft as number, "the left fragment lost the head").toBeGreaterThan(0.05);
    expect(report.splitRight as number, "the right fragment did not continue at the source position").toBeGreaterThan(0.05);
    expect(report.splitRightRestarted as number, "the right fragment restarted at the source head").toBeLessThan(0.005);
    expect(report.splitControl as number, "the unsplit control was not at 660 Hz").toBeGreaterThan(0.05);
    expect(report.splitRightStartBar as number).toBe(2);
    expect(report.splitRightOffsetSec as number, "the right fragment's source advance is wrong").toBeCloseTo(4, 6);

    // ── REVERSE ───────────────────────────────────────────────────────────
    expect(report.reverseHeadControl as number).toBeGreaterThan(0.05);
    expect(report.reverseTailControl as number).toBeGreaterThan(0.05);
    expect(report.reverseHead as number, "the reversed clip does not start at the source's tail").toBeGreaterThan(0.05);
    expect(report.reverseTail as number, "the reversed clip does not end at the source's head").toBeGreaterThan(0.05);
    expect(report.reverseHeadOld as number, "the reversed head still sounds like the forward head").toBeLessThan(0.005);
    expect(report.reverseTailOld as number, "the reversed tail still sounds like the forward tail").toBeLessThan(0.005);
    expect(report.reverseFlag).toBe(true);

    // ── GAIN ──────────────────────────────────────────────────────────────
    expect(report.gainBefore as number, "the gain fixture was silent").toBeGreaterThan(0.05);
    const gainRatio = (report.gainBefore as number) / Math.max(1e-6, report.gainAfter as number);
    expect(gainRatio, `gain 0.25 should divide the amplitude by 4, measured ${gainRatio.toFixed(3)}`).toBeCloseTo(4, 1);
    expect(report.gainWrongFrequency as number, "the gain changed the source itself").toBeLessThan(0.005);

    // ── LOOP ──────────────────────────────────────────────────────────────
    expect(report.loopHead as number, "the looped clip is silent at its head").toBeGreaterThan(0.05);
    expect(report.loopSecond as number, "the looped clip's second half is wrong").toBeGreaterThan(0.05);
    expect(report.loopTailControl as number, "the loop fixture's tail was never silent").toBeLessThan(0.005);
    expect(report.loopTailControlSecond as number).toBeLessThan(0.005);
    expect(report.loopTail as number, "the loop did not repeat the source at the clip's tail").toBeGreaterThan(0.05);
    expect(report.loopTailSecond as number, "the loop repeated the wrong phase").toBeGreaterThan(0.05);
    expect(report.loopFlag).toBe(true);

    // ── DUPLICATE ─────────────────────────────────────────────────────────
    expect(report.dupCount as number, "the duplicate did not add a clip").toBe(2);
    expect(report.dupOriginal as number, "the original stopped sounding").toBeGreaterThan(0.05);
    expect(report.dupCopyControl as number, "the duplicate fixture's second half was never silent").toBeLessThan(0.005);
    expect(report.dupCopy as number, "the copy lost the source position").toBeGreaterThan(0.05);
    expect(report.dupCopyReset as number, "the copy reset the source position").toBeLessThan(0.005);
    expect(report.dupCopyOffsetSec as number, "the copy's source offset was not carried").toBeCloseTo(4, 6);
    expect(report.dupCopyGain as number, "the copy's gain was not carried").toBe(1);

    // ── PASTE ─────────────────────────────────────────────────────────────
    expect(report.pasteCount as number, "the paste did not add a clip").toBe(2);
    expect(report.pasteHeadControl as number, "the paste fixture's target was never silent").toBeLessThan(0.005);
    expect(report.pasteHead as number, "the pasted clip lost the source position").toBeGreaterThan(0.05);
    expect(report.pasteHeadReset as number, "the pasted clip reset the source position").toBeLessThan(0.005);
    expect(report.pasteCopyOffsetSec as number, "the pasted clip's source offset was not carried").toBeCloseTo(4, 6);
  });

  /**
   * UNDO must restore the AUDIBLE state, not just the document shape. The
   * wave-3 matrices check that undo restores the document; this checks that
   * the document it restores to RENDERS THE SAME AUDIO. A stale `offsetSec`
   * or a leftover `reverse` flag would leave the document looking right and
   * the song sounding wrong.
   */
  test("undo restores the RENDERED audio, not just the document", async ({ page }) => {
    test.setTimeout(300_000);
    await openHouseTemplate(page);

    const report = await page.evaluate(async () => {
      const load = (specifier: string) => import(/* @vite-ignore */ specifier);
      const [templateModule, commandModule, sampleModule, rendererModule, storeModule, schemaModule] = await Promise.all([
        load("/src/project-model/templates.ts"),
        load("/src/commands/commands.ts"),
        load("/src/sample-library/factory.ts"),
        load("/src/rendering/renderer.ts"),
        load("/src/store/ProjectStore.ts"),
        load("/src/project-model/schema.ts"),
      ]);
      const { createProjectFromTemplate } = templateModule;
      const { addAudioClip, updateAudioClip, trimAudioClipStart } = commandModule;
      const { SampleBank } = sampleModule;
      const { renderProject } = rendererModule;
      const { ProjectStore } = storeModule;
      const { ticksPerBar } = schemaModule;

      const sampleRate = 44_100;
      const BAR_SEC = 2;
      const TONE_SECONDS = 16;
      const STAIR = [220, 440, 660, 880, 1100, 1320, 1540, 1760];

      const makeStair = (): AudioBuffer => {
        const buffer = new OfflineAudioContext(1, sampleRate * TONE_SECONDS, sampleRate).createBuffer(
          1,
          sampleRate * TONE_SECONDS,
          sampleRate,
        );
        const samples = buffer.getChannelData(0);
        for (let frame = 0; frame < samples.length; frame++) {
          const t = frame / sampleRate;
          const segment = Math.min(STAIR.length - 1, Math.floor(t / BAR_SEC));
          const local = t - segment * BAR_SEC;
          samples[frame] = 0.2 * Math.sin(2 * Math.PI * STAIR[segment] * local);
        }
        return buffer;
      };

      const bank = new SampleBank();
      bank.add("w29.stair", makeStair());

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

      /** Largest sample-by-sample difference between two renders. */
      const maxAbsDiff = (a: AudioBuffer, b: AudioBuffer): number => {
        const left = a.getChannelData(0);
        const right = b.getChannelData(0);
        const count = Math.min(left.length, right.length);
        let worst = 0;
        for (let index = 0; index < count; index++) {
          const diff = Math.abs((left[index] ?? 0) - (right[index] ?? 0));
          if (diff > worst) worst = diff;
        }
        return worst;
      };

      const render = async (project: ProjectDocument) =>
        renderProject(project, bank, { mode: "song", sampleRate, tailSeconds: 0 });

      const template = createProjectFromTemplate("empty");
      const track = template.tracks[0];
      if (!track) throw new Error("empty-project audio track fixture missing");
      const bare = { ...template, arrangement: { ...template.arrangement, clips: [], audioClips: [] } };
      const base = addAudioClip(bare, track.id, "w29.stair", 0, 4).execute(bare);
      const baseClip = base.arrangement.audioClips?.[0];
      if (!baseClip) throw new Error("staircase fixture lost its clip");
      const baseId = baseClip.id;

      const out: Record<string, unknown> = {};

      /** One verb: edit → measure → undo → measure the restored audio. */
      const roundTrip = async (
        key: string,
        build: (doc: ProjectDocument, clipId: string) => any,
        probe: (buffer: AudioBuffer) => number,
      ) => {
        const store = new ProjectStore(base);
        const pristine = store.getDoc();
        const pristineRender = await render(pristine);
        store.execute(build(pristine, baseId));
        const editedRender = await render(store.getDoc());
        store.undo();
        const undoneRender = await render(store.getDoc());
        out[`${key}Pristine`] = probe(pristineRender);
        out[`${key}Edited`] = probe(editedRender);
        out[`${key}Undone`] = probe(undoneRender);
        out[`${key}UndoneDiff`] = maxAbsDiff(pristineRender, undoneRender);
        out[`${key}EditedDiff`] = maxAbsDiff(pristineRender, editedRender);
      };

      await roundTrip(
        "gain",
        (doc, clipId) => updateAudioClip(doc, clipId, { gain: 0.25 }),
        (buffer) => amplitudeAt(buffer, 220, 0.5),
      );

      await roundTrip(
        "reverse",
        (doc, clipId) => updateAudioClip(doc, clipId, { reverse: true }),
        (buffer) => amplitudeAt(buffer, 880, 0.5),
      );

      await roundTrip(
        "trim",
        (doc, clipId) =>
          trimAudioClipStart(doc, clipId, {
            startBar: 1,
            lengthBars: 3,
            trimStart: 0,
            offsetSec: 2,
          }),
        (buffer) => amplitudeAt(buffer, 220, 0.5),
      );

      out.barTicks = ticksPerBar(base);
      out.barSec = BAR_SEC;

      return out;
    });

    // ── GAIN: undo restores the original level, bit for bit ───────────────
    expect(report.gainPristine as number, "the pristine render is silent").toBeGreaterThan(0.05);
    expect(report.gainEdited as number, "the gain edit is silent").toBeLessThan(0.05);
    expect(report.gainUndone as number, "undo did not restore the level").toBeGreaterThan(0.05);
    expect(report.gainUndoneDiff as number, "undo did not restore the audio sample-for-sample").toBeLessThan(1e-6);
    // The guard above only means something if the edit actually changed the audio.
    expect(report.gainEditedDiff as number, "the gain edit did not change the render at all").toBeGreaterThan(0.05);

    // ── REVERSE: undo restores the forward direction ─────────────────────
    expect(report.reversePristine as number, "the pristine render has no 880 Hz at the head").toBeLessThan(0.005);
    expect(report.reverseEdited as number, "the reverse edit is silent at the head").toBeGreaterThan(0.05);
    expect(report.reverseUndone as number, "undo left the clip reversed").toBeLessThan(0.005);
    expect(report.reverseUndoneDiff as number, "undo did not restore the forward audio").toBeLessThan(1e-6);
    expect(report.reverseEditedDiff as number, "the reverse edit did not change the render at all").toBeGreaterThan(0.05);

    // ── TRIM START: undo restores the source position ────────────────────
    expect(report.trimPristine as number, "the pristine render is silent at the head").toBeGreaterThan(0.05);
    expect(report.trimEdited as number, "the trim did not vacate the head").toBeLessThan(0.005);
    expect(report.trimUndone as number, "undo did not bring the head back").toBeGreaterThan(0.05);
    expect(report.trimUndoneDiff as number, "undo did not restore the trimmed audio").toBeLessThan(1e-6);
    expect(report.trimEditedDiff as number, "the trim did not change the render at all").toBeGreaterThan(0.05);
  });
});
