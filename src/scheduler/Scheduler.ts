import type { DrumTrack, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, getActivePattern, STEP_TICKS } from "../project-model/types";
import type { Transport } from "../transport/Transport";

export interface SchedulerDeps {
  getProject(): ProjectDocument;
  getTransport(): Transport;
  getAudioTime(): number;
  getMode(): PlayMode;
  trigger(trackId: string, pad: DrumTrack["pads"][number], when: number, velocity: number): void;
  noteOn(trackId: string, pitch: number, velocity: number, when: number, durationSec: number): void;
  applyAutomation(fromTick: number, toTick: number, relOf: (tick: number) => number): void;
}

const INTERVAL_MS = 25;
const HORIZON_SECONDS = 0.12;

const mod = (value: number, m: number): number => ((value % m) + m) % m;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private windowStartTick = 0;
  private stopped = true;
  stats = { scheduledEvents: 0, lastHorizonTick: 0, windows: 0 };

  constructor(private deps: SchedulerDeps) {}

  get isRunning(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (this.timer !== null) return;
    const transport = this.deps.getTransport();
    this.windowStartTick = Math.max(0, transport.position);
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopped = true;
  }

  private tick(): void {
    const transport = this.deps.getTransport();
    if (!transport.playing) {
      this.stop();
      return;
    }
    const now = this.deps.getAudioTime();
    const horizon = now + HORIZON_SECONDS;
    const windowEnd = transport.tickAt(horizon);
    const windowStart = this.windowStartTick;
    if (windowEnd <= windowStart) {
      this.stats.windows += 1;
      return;
    }
    const doc = this.deps.getProject();
    const mode = this.deps.getMode();

    let automationCtx: { base: number; patternTicks: number } | null = null;

    if (mode === "pattern") {
      const pattern = getActivePattern(doc);
      const patternTicks = STEP_TICKS * pattern.stepCount;
      this.schedulePatternWindow(pattern, 0, patternTicks, windowStart, windowEnd);
      automationCtx = { base: 0, patternTicks };
    } else {
      const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
      for (const clip of clips) {
        const clipStart = clip.startBar * BAR_TICKS;
        const clipEnd = clipStart + clip.lengthBars * BAR_TICKS;
        const s = Math.max(windowStart, clipStart);
        const e = Math.min(windowEnd, clipEnd);
        if (e <= s) continue;
        const scene = doc.scenes.find((sc) => sc.id === clip.sceneId);
        if (!scene) continue;
        const pattern = doc.patterns.find((p) => p.id === scene.patternId);
        if (!pattern) continue;
        const patternTicks = STEP_TICKS * pattern.stepCount;
        this.schedulePatternWindow(pattern, clipStart, patternTicks, s, e);
        if (!automationCtx && windowStart >= clipStart) {
          automationCtx = { base: clipStart, patternTicks };
        }
      }
      if (!automationCtx) {
        const covering = clips.find((c) => {
          const cs = c.startBar * BAR_TICKS;
          return windowStart >= cs && windowStart < cs + c.lengthBars * BAR_TICKS;
        });
        if (covering) {
          const scene = doc.scenes.find((sc) => sc.id === covering.sceneId);
          const pattern = scene ? doc.patterns.find((p) => p.id === scene.patternId) : undefined;
          const patternTicks = pattern ? STEP_TICKS * pattern.stepCount : STEP_TICKS * 16;
          automationCtx = { base: covering.startBar * BAR_TICKS, patternTicks };
        }
      }
    }

    if (automationCtx) {
      const { base, patternTicks } = automationCtx;
      this.deps.applyAutomation(windowStart, windowEnd, (tick) => mod(tick - base, patternTicks));
    }

    this.windowStartTick = windowEnd;
    this.stats.lastHorizonTick = windowEnd;
    this.stats.windows += 1;
  }

  private schedulePatternWindow(
    pattern: Pattern,
    base: number,
    patternTicks: number,
    windowStart: number,
    windowEnd: number,
  ): void {
    const transport = this.deps.getTransport();
    const doc = this.deps.getProject();
    const now = this.deps.getAudioTime();
    const timeAt = (tick: number) => transport.timeAtTick(tick);
    const audible = (when: number) => when >= now - 0.002;

    const relStart = mod(windowStart - base, patternTicks);
    const firstStep = Math.ceil(windowStart / STEP_TICKS - 1e-9) * STEP_TICKS;
    for (let t = firstStep; t < windowEnd; t += STEP_TICKS) {
      const when = timeAt(t);
      if (!audible(when)) continue;
      const stepIndex = Math.floor(mod(t - base, patternTicks) / STEP_TICKS) % pattern.stepCount;
      this.scheduleDrums(doc, pattern, stepIndex, when);
    }

    for (const track of doc.tracks) {
      if (track.kind !== "instrument") continue;
      const notes = pattern.notes?.[track.id];
      if (!notes || notes.length === 0) continue;
      for (const note of notes) {
        let occ = windowStart + mod(note.start - relStart, patternTicks);
        for (; occ < windowEnd; occ += patternTicks) {
          const when = timeAt(occ);
          if (!audible(when)) continue;
          this.deps.noteOn(track.id, note.pitch, note.velocity, when, note.duration * transport.secondsPerTick);
          this.stats.scheduledEvents += 1;
        }
      }
    }
  }

  private scheduleDrums(doc: ProjectDocument, pattern: Pattern, stepIndex: number, when: number): void {
    const tracks = doc.tracks.filter((t): t is DrumTrack => t.kind === "drum");
    const anyTrackSolo = doc.tracks.some((t) => t.solo);
    for (const track of tracks) {
      if (track.mute || (anyTrackSolo && !track.solo)) continue;
      const anyPadSolo = track.pads.some((p) => p.solo);
      for (const pad of track.pads) {
        const velocity = pattern.rows[pad.id]?.[stepIndex] ?? 0;
        if (velocity <= 0) continue;
        if (pad.mute) continue;
        if (anyPadSolo && !pad.solo) continue;
        this.deps.trigger(track.id, pad, when, velocity);
        this.stats.scheduledEvents += 1;
      }
    }
  }
}
