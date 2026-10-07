import { AudioEngine } from "./audio-engine/AudioEngine";
import { LiveRecorder } from "./audio-engine/recorder";
import { resumeSpanningAudioClips, syncDocChangeWhilePlaying } from "./audio-engine/liveEditSync";
import { Scheduler } from "./scheduler/Scheduler";
import { createSchedulerDriver } from "./scheduler/schedulerDriver";
import { Transport } from "./transport/Transport";
import { loadCoreWorklets } from "./audio-worklets/loader";
import { createDefaultProject } from "./project-model/schema";
import { ProjectStore } from "./store/ProjectStore";
import { SampleBank } from "./sample-library/factory";
import {
  addAudioClip,
  deleteAudioClip,
  duplicateAudioClip,
  moveAudioClip,
  resizeAudioClip,
  splitAudioClipAtTick,
  updateAudioClip,
} from "./commands/commands";
import type { AudioClip, ProjectDocument } from "./project-model/types";
import { BAR_TICKS, PPQ } from "./project-model/types";

/**
 * LIVE EDITING PASS — edit-the-timeline-while-it-plays, verified by EAR.
 *
 * Boots the real stack in a realtime AudioContext (engine + transport +
 * scheduler + audio-clock driver), plays an 8-second tone clip, and performs
 * one editing gesture per scenario while the transport runs. Each scenario
 * records the master tap through LiveRecorder and analyses the take:
 *
 *  - All assertions are TIMING-FREE (tail RMS / silent-gap shape). MediaRecorder
 *    startup latency in headless shifts the take by an unknown offset, so
 *    nothing is asserted against a wall-clock position; margins are sized so a
 *    ±0.5 s shift cannot flip a verdict.
 *
 *  - Transport gestures mirror services.ts 1:1 (play = play + transportStarted
 *    + frozen restart + scheduler.start; seek = seek + panic + transportStarted
 *    + frozen restart + scheduler.resync), so the scheduler/engine see exactly
 *    what a user gesture produces in the app.
 *
 *  - The doc-change → engine wiring mirrors services.ts's store.onDocChanged
 *    audio branch 1:1 (setProject + frozen restart while playing). When the
 *    live-edit sync helper lands, both call the same function — this pass then
 *    exercises the shipped path, not a replica.
 *
 * Scenarios (expected verdict BEFORE the doc-change flush fix):
 *  S0 baseline         — untouched playback is audible (harness sanity)
 *  S1 delete-ghost     — deleting the PLAYING clip must silence it
 *                        (before fix: orphaned source rings to its scheduled
 *                        end → tail audible → FAIL)
 *  S2 seek-resume      — seeking INTO a playing clip's body must resume it
 *                        (before fix: clips only fire when their START enters
 *                        a window → permanent silence → FAIL)
 *  S3 split-continuity — split at the playhead must not open a hole
 *                        (regression guard for the fix's de-click cancel)
 *  S4 move-resume      — moving a playing clip right; seeking to the new
 *                        position resumes it
 *                        (before fix: ghost rings → tail silent after seek → FAIL)
 *  S5 undo-resume      — delete then UNDO while playing: the restored clip
 *                        resumes from the playhead
 *                        (before fix: ghost rings continuously → no gap → FAIL)
 *  S6 edit storm       — rapid mixed edits while playing: transport stays up,
 *                        position monotonic, document stays valid
 */

export interface LiveEditingCheckResult {
  name: string;
  ok: boolean;
  message: string;
}

const CLIP_BARS = 4; // 4 bars @120 bpm = 8 s of tone
const TONE_ID = "live-edit-tone";
const SILENCE_RMS = 0.02;
const AUDIBLE_RMS = 0.05;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilAudioTime(ctx: AudioContext, targetSec: number): Promise<void> {
  // Headless audio clocks can stall under load; bail out after a generous
  // wall-clock budget rather than hanging the whole pass.
  const deadline = Date.now() + 30_000;
  while (ctx.currentTime < targetSec) {
    if (Date.now() > deadline) throw new Error(`audio clock stalled at ${ctx.currentTime.toFixed(2)}s`);
    await sleep(15);
  }
}

/** Windowed RMS over a mono channel. */
function windowedRms(data: Float32Array, sampleRate: number, windowSec = 0.05): Float32Array {
  const window = Math.max(1, Math.floor(windowSec * sampleRate));
  const count = Math.floor(data.length / window);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const base = i * window;
    for (let j = 0; j < window; j++) {
      const v = data[base + j] ?? 0;
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / window);
  }
  return out;
}

interface TakeShape {
  longestSilentGapSec: number;
  tailRms: number;
  earlyRms: number;
  peak: number;
}

function analyseTake(buffer: AudioBuffer, tailSec = 1.0, earlySec = 0.5): TakeShape {
  const data = buffer.getChannelData(0);
  const rms = windowedRms(data, buffer.sampleRate);
  const windowSec = 0.05;
  let longest = 0;
  let run = 0;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < SILENCE_RMS) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  const mean = (slice: Float32Array): number =>
    slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  const tailRms = mean(rms.slice(Math.max(0, rms.length - Math.floor(tailSec / windowSec))));
  const earlyRms = mean(rms.slice(0, Math.min(rms.length, Math.floor(earlySec / windowSec))));
  let peak = 0;
  for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i] ?? 0));
  return { longestSilentGapSec: longest * windowSec, tailRms, earlyRms, peak };
}

const shapeMessage = (s: TakeShape): string =>
  `gap=${s.longestSilentGapSec.toFixed(2)}s tailRMS=${s.tailRms.toFixed(3)} earlyRMS=${s.earlyRms.toFixed(3)} peak=${s.peak.toFixed(3)}`;

export async function runLiveEditingChecks(onProgress?: (message: string) => void): Promise<LiveEditingCheckResult[]> {
  const results: LiveEditingCheckResult[] = [];
  const progress = (message: string): void => onProgress?.(message);
  const check = (name: string, ok: boolean, message: string): void => {
    results.push({ name, ok, message });
    progress(`[${ok ? "PASS" : "FAIL"}] ${name} — ${message}`);
  };

  if (typeof MediaRecorder === "undefined") {
    check("live-editing pass", true, "skipped — MediaRecorder unavailable in this browser");
    return results;
  }

  const ctx = new AudioContext();
  try {
    if (ctx.state === "suspended") await ctx.resume();
    await loadCoreWorklets(ctx);

    const bank = new SampleBank();
    const tone = ctx.createBuffer(1, Math.ceil(8 * ctx.sampleRate), ctx.sampleRate);
    const toneData = tone.getChannelData(0);
    for (let i = 0; i < toneData.length; i++) toneData[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
    bank.add(TONE_ID, tone);

    const engine = new AudioEngine();
    engine.attachBank(bank);
    engine.useContext(ctx);

    const freshDoc = (): ProjectDocument => createDefaultProject();
    const store = new ProjectStore(freshDoc());
    engine.setProject(store.doc);

    const transport = new Transport({ now: () => ctx.currentTime }, store.doc.bpm);
    const scheduler = new Scheduler({
      getProject: () => store.doc,
      getTransport: () => transport,
      getAudioTime: () => ctx.currentTime,
      getMode: () => "song",
      trigger: () => {},
      noteOn: () => {},
      applyAutomation: () => {},
      applyPatternLaunch: () => {},
      triggerAudioClip: (clip, when, durationSec, resumeOffsetSec) =>
        engine.triggerAudioClip(clip, when, durationSec, resumeOffsetSec),
    });
    const driver = createSchedulerDriver(ctx, { createGain: () => ctx.createGain() });
    if (driver) scheduler.setDriver(driver);

    // Doc-change → engine wiring — the SHARED live-editing sync (the same
    // functions services.ts calls), plus the services-shaped play/seek
    // gestures below, so this pass exercises the shipped path.
    store.onDocChanged = (doc) => {
      engine.setProject(doc);
      if (transport.playing) syncDocChangeWhilePlaying({ engine, transport, getDoc: () => doc });
    };

    const recorder = new LiveRecorder({
      ctx,
      getTapNode: (source) => (source.kind === "master" ? engine.getMasterTapNode() : null),
    });

    const clipOf = (doc: ProjectDocument): AudioClip | undefined => (doc.arrangement.audioClips ?? [])[0];

    /** Reset transport/engine for a new scenario; returns a fresh tone-clip id at `startBar`. */
    const resetScenario = (startBar = 0): string => {
      scheduler.stop();
      transport.stop();
      engine.panic();
      // createDefaultProject mints fresh track ids per call — resolve the
      // destination track against THIS doc, not a captured one.
      const base = freshDoc();
      const trackId = base.tracks[0]!.id;
      const doc = addAudioClip(base, trackId, TONE_ID, startBar, CLIP_BARS, { fadeIn: 0, fadeOut: 0 }).execute(base);
      store.replaceDoc(doc);
      return clipOf(store.doc)!.id;
    };

    const beatPhase = (t: Transport): number => ((t.position % PPQ) + PPQ) % PPQ;

    // services.ts playPause (play branch), audio-relevant core.
    const playLive = (): void => {
      engine.transportStarted(engine.currentTime, beatPhase(transport) / PPQ, transport.position / PPQ);
      engine.restartFrozenSources(transport.position);
      resumeSpanningAudioClips({ engine, transport, getDoc: () => store.doc });
      scheduler.start();
    };

    // services.ts seek (playing branch), audio-relevant core.
    const seekLive = (tick: number): void => {
      transport.seek(Math.max(0, tick));
      if (!transport.playing) return;
      engine.panic();
      engine.transportStarted(engine.currentTime, beatPhase(transport) / PPQ, transport.position / PPQ);
      engine.restartFrozenSources(transport.position);
      scheduler.resync();
      resumeSpanningAudioClips({ engine, transport, getDoc: () => store.doc });
    };

    const recordTake = async (
      script: (t0: number) => Promise<void>,
      durationSec: number,
    ): Promise<TakeShape | null> => {
      await recorder.start({ kind: "master" });
      const t0 = ctx.currentTime;
      await script(t0);
      await waitUntilAudioTime(ctx, t0 + durationSec);
      const take = await recorder.stop();
      if (!take) return null;
      return analyseTake(take.buffer);
    };

    // ── S0 baseline ──────────────────────────────────────────────
    try {
      let shape: TakeShape | null = null;
      for (let attempt = 0; attempt < 2 && (!shape || shape.peak <= SILENCE_RMS); attempt++) {
        resetScenario(0);
        shape = await recordTake(async () => {
          transport.play(0, { leadIn: false });
          playLive();
        }, 3.0);
      }
      if (!shape) throw new Error("recorder produced no take");
      check(
        "live-edit S0: untouched playback is audible on the master tap",
        shape.earlyRms > AUDIBLE_RMS && shape.tailRms > AUDIBLE_RMS && shape.peak > AUDIBLE_RMS,
        shapeMessage(shape),
      );
    } catch (error) {
      check("live-edit S0 baseline", false, String(error));
    }

    // ── S1 delete the playing clip ───────────────────────────────
    try {
      const clipId = resetScenario(0);
      const shape = await recordTake(async (t0) => {
        transport.play(0, { leadIn: false });
        playLive();
        await waitUntilAudioTime(ctx, t0 + 2.0);
        store.execute(deleteAudioClip(store.doc, clipId));
      }, 4.0);
      if (!shape) throw new Error("recorder produced no take");
      const tailSilent = shape.tailRms < SILENCE_RMS;
      const earlyAudible = shape.earlyRms > AUDIBLE_RMS;
      check(
        "live-edit S1: deleting the playing clip stops it sounding (no ghost to scheduled end)",
        tailSilent && earlyAudible,
        `${shapeMessage(shape)} tailSilent=${tailSilent} earlyAudible=${earlyAudible}`,
      );
    } catch (error) {
      check("live-edit S1 delete-ghost", false, String(error));
    }

    // ── S2 seek into the clip body ───────────────────────────────
    try {
      resetScenario(0);
      const shape = await recordTake(async (t0) => {
        transport.play(0, { leadIn: false });
        playLive();
        await waitUntilAudioTime(ctx, t0 + 1.0);
        seekLive(2 * BAR_TICKS); // bar 2 — the clip's temporal middle
      }, 4.5);
      if (!shape) throw new Error("recorder produced no take");
      const tailAudible = shape.tailRms > AUDIBLE_RMS;
      check(
        "live-edit S2: seeking into a playing clip resumes it from the playhead",
        tailAudible,
        `${shapeMessage(shape)} tailAudible=${tailAudible}`,
      );
    } catch (error) {
      check("live-edit S2 seek-resume", false, String(error));
    }

    // ── S3 split at the playhead ─────────────────────────────────
    try {
      const clipId = resetScenario(0);
      const shape = await recordTake(async (t0) => {
        transport.play(0, { leadIn: false });
        playLive();
        await waitUntilAudioTime(ctx, t0 + 2.0);
        store.execute(splitAudioClipAtTick(store.doc, clipId, transport.position, 8));
      }, 4.0);
      if (!shape) throw new Error("recorder produced no take");
      const noHole = shape.longestSilentGapSec < 0.8 && shape.tailRms > AUDIBLE_RMS && shape.earlyRms > AUDIBLE_RMS;
      check(
        "live-edit S3: splitting at the playhead keeps the audio continuous",
        noHole,
        `${shapeMessage(shape)} noHole=${noHole}`,
      );
    } catch (error) {
      check("live-edit S3 split-continuity", false, String(error));
    }

    // ── S4 move the playing clip right, then seek to it ─────────
    try {
      const clipId = resetScenario(0);
      const shape = await recordTake(async (t0) => {
        transport.play(0, { leadIn: false });
        playLive();
        await waitUntilAudioTime(ctx, t0 + 1.5);
        store.execute(moveAudioClip(store.doc, clipId, 8)); // out from under the playhead
        await waitUntilAudioTime(ctx, t0 + 3.0);
        seekLive(9 * BAR_TICKS); // into the clip's new body (bars 8..12)
      }, 6.0);
      if (!shape) throw new Error("recorder produced no take");
      const gapExists = shape.longestSilentGapSec >= 0.8; // died at the old spot
      const tailAudible = shape.tailRms > AUDIBLE_RMS; // resumed at the new spot
      check(
        "live-edit S4: moving a playing clip right silences the old spot and resumes after seek",
        gapExists && tailAudible,
        `${shapeMessage(shape)} gapExists=${gapExists} tailAudible=${tailAudible}`,
      );
    } catch (error) {
      check("live-edit S4 move-resume", false, String(error));
    }

    // ── S5 delete then undo while playing ────────────────────────
    try {
      const clipId = resetScenario(0);
      const shape = await recordTake(async (t0) => {
        transport.play(0, { leadIn: false });
        playLive();
        await waitUntilAudioTime(ctx, t0 + 1.5);
        store.execute(deleteAudioClip(store.doc, clipId));
        await waitUntilAudioTime(ctx, t0 + 3.0);
        store.undo();
      }, 6.0);
      if (!shape) throw new Error("recorder produced no take");
      const gapExists = shape.longestSilentGapSec >= 0.8;
      const tailAudible = shape.tailRms > AUDIBLE_RMS;
      check(
        "live-edit S5: undo during playback restores the clip sounding from the playhead",
        gapExists && tailAudible,
        `${shapeMessage(shape)} gapExists=${gapExists} tailAudible=${tailAudible}`,
      );
    } catch (error) {
      check("live-edit S5 undo-resume", false, String(error));
    }

    // ── S6 edit storm while playing ──────────────────────────────
    try {
      resetScenario(0);
      let lastPos = -1;
      let monotonic = true;
      let editCount = 0;
      const shape = await recordTake(async (t0) => {
        transport.play(0, { leadIn: false });
        playLive();
        await waitUntilAudioTime(ctx, t0 + 1.0);
        const liveClip = (): AudioClip => {
          const c = (store.doc.arrangement.audioClips ?? []).find((x) => x.bufferId === TONE_ID);
          if (!c) throw new Error("storm: tone clip vanished");
          return c;
        };
        const edits: Array<() => void> = [
          () => store.execute(moveAudioClip(store.doc, liveClip().id, 1)),
          () => store.execute(resizeAudioClip(store.doc, liveClip().id, 3)),
          () => store.execute(updateAudioClip(store.doc, liveClip().id, { fadeIn: 0.05, fadeOut: 0.05 })),
          () => store.execute(duplicateAudioClip(store.doc, liveClip().id)),
          () => {
            const copy = (store.doc.arrangement.audioClips ?? []).find(
              (c) => c.bufferId === TONE_ID && c.id !== liveClip().id,
            );
            if (copy) store.execute(deleteAudioClip(store.doc, copy.id));
          },
          () => store.undo(),
          () => store.redo(),
          () => {
            const c = liveClip();
            store.execute(splitAudioClipAtTick(store.doc, c.id, c.startBar * BAR_TICKS + 960, 8));
          },
          () => store.undo(),
          () => store.undo(),
          () => store.redo(),
        ];
        for (const edit of edits) {
          edit();
          editCount += 1;
          const p = transport.position;
          if (p < lastPos - 1e-6) monotonic = false;
          lastPos = p;
          await waitUntilAudioTime(ctx, ctx.currentTime + 0.12);
        }
      }, 4.5);
      if (!shape) throw new Error("recorder produced no take");
      const clips = store.doc.arrangement.audioClips ?? [];
      const valid = clips.every(
        (c) =>
          Number.isFinite(c.startBar) &&
          Number.isFinite(c.lengthBars) &&
          c.lengthBars >= 0.25 &&
          Number.isFinite(c.fadeIn) &&
          Number.isFinite(c.fadeOut),
      );
      const stable = transport.playing && monotonic && valid && shape.peak > SILENCE_RMS;
      check(
        "live-edit S6: rapid mixed edits during playback keep transport + document stable",
        stable,
        `${shapeMessage(shape)} playing=${transport.playing} monotonic=${monotonic} valid=${valid} clips=${clips.length} edits=${editCount}`,
      );
    } catch (error) {
      check("live-edit S6 edit storm", false, String(error));
    }

    scheduler.stop();
    transport.stop();
    engine.panic();
  } finally {
    await ctx.close();
  }

  return results;
}
