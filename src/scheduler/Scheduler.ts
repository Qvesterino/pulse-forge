import type { DrumTrack, Pattern, PlayMode, ProjectDocument } from "../project-model/types";
import { BAR_TICKS, getActivePattern, STEP_TICKS } from "../project-model/types";
import { drumHitsInWindow } from "../project-model/groove";
import type { Transport } from "../transport/Transport";

export interface SchedulerDeps {
  getProject(): ProjectDocument;
  getTransport(): Transport;
  getAudioTime(): number;
  getMode(): PlayMode;
  trigger(trackId: string, pad: DrumTrack["pads"][number], when: number, velocity: number): void;
  noteOn(trackId: string, pitch: number, velocity: number, when: number, durationSec: number): void;
  applyAutomation(fromTick: number, toTick: number, relOf: (tick: number) => number): void;
  /** Commit a queued (quantized) pattern launch into the project model. */
  applyPatternLaunch(patternId: string): void;
}

const INTERVAL_MS = 25;
const HORIZON_SECONDS = 0.12;

const mod = (value: number, m: number): number => ((value % m) + m) % m;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private windowStartTick = 0;
  private stopped = true;
  private pendingLaunch: { patternId: string; atTick: number } | null = null;
  stats = { scheduledEvents: 0, lastHorizonTick: 0, windows: 0 };
  private listeners = new Set<() => void>();

  constructor(private deps: SchedulerDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  /** Pattern id waiting for a quantized launch, if any (for UI indication). */
  get pendingPatternId(): string | null {
    return this.pendingLaunch?.patternId ?? null;
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
    // A queued scene launch survives a stop as an immediate switch — the user
    // asked for that pattern; stopping should not silently discard the choice.
    if (this.pendingLaunch) {
      this.deps.applyPatternLaunch(this.pendingLaunch.patternId);
      this.pendingLaunch = null;
      this.notify();
    }
    this.stopped = true;
  }

  /** Re-align the scheduling window to the transport (after a seek while playing). */
  resync(): void {
    const transport = this.deps.getTransport();
    this.windowStartTick = Math.max(0, transport.position);
  }

  /** Queue a pattern switch at an absolute tick (next bar boundary for scene launches). */
  queuePatternLaunch(patternId: string, atTick: number): void {
    this.pendingLaunch = { patternId, atTick };
    this.notify();
  }

  cancelPatternLaunch(): void {
    if (this.pendingLaunch) {
      this.pendingLaunch = null;
      this.notify();
    }
  }

  private tick(): void {
    const transport = this.deps.getTransport();
    if (!transport.playing) {
      this.stop();
      return;
    }
    if (transport.loopEnabled) {
      const doc = this.deps.getProject();
      const mode = this.deps.getMode();
      const loopStart = transport.loopStart;
      const loopEnd =
        transport.loopEnd > 0
          ? transport.loopEnd
          : mode === "pattern"
            ? STEP_TICKS * getActivePattern(doc).stepCount
            : Math.max(
                0,
                ...doc.arrangement.clips.map((c) => (c.startBar + c.lengthBars) * BAR_TICKS),
              );
      const position = transport.position;
      if (position >= loopEnd || position < loopStart) {
        transport.seek(loopStart);
        this.windowStartTick = loopStart;
      }
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
      let currentDoc = doc;
      // A queued launch whose boundary we already passed (e.g. after a seek)
      // commits immediately.
      if (this.pendingLaunch && this.pendingLaunch.atTick <= windowStart) {
        this.deps.applyPatternLaunch(this.pendingLaunch.patternId);
        this.pendingLaunch = null;
        this.notify();
        currentDoc = this.deps.getProject();
      }
      const pattern = getActivePattern(currentDoc);
      const patternTicks = STEP_TICKS * pattern.stepCount;
      const pending = this.pendingLaunch;
      const boundary =
        pending && pending.atTick > windowStart && pending.atTick <= windowEnd ? pending.atTick : null;

      this.schedulePatternWindow(pattern, 0, patternTicks, windowStart, boundary ?? windowEnd);
      automationCtx = { base: 0, patternTicks };

      if (boundary !== null && pending) {
        // Split the window at the launch boundary: old pattern before it,
        // new pattern after — the switch lands exactly on the quantized tick.
        this.deps.applyPatternLaunch(pending.patternId);
        this.pendingLaunch = null;
        this.notify();
      }
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

    for (const hit of drumHitsInWindow(doc, pattern, base, windowStart, windowEnd)) {
      const when = timeAt(hit.tick);
      if (!audible(when)) continue;
      this.deps.trigger(hit.trackId, hit.pad, when, hit.velocity);
      this.stats.scheduledEvents += 1;
    }

    const relStart = mod(windowStart - base, patternTicks);
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
}
