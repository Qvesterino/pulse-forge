import { PPQ } from "../project-model/types";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => performance.now() / 1000 };

/** Ticks per bar (4/4) — matches BAR_TICKS without importing the model (transport stays model-independent). */
const BAR_TICKS_ = PPQ * 4;

export class Transport {
  private bpm_: number;
  private playing_ = false;
  private anchorTick = 0;
  private anchorTime = 0;
  private pauseTick = 0;
  private loopEnabled_ = false;
  private loopStart_ = 0;
  private loopEnd_ = 0;
  /** Metronome count-in length in bars (0 = off, 1..2). */
  private countInBars_ = 0;
  /** Pre-roll length in bars (0 = off, 1) — playback starts this many bars early. */
  private preRollBars_ = 0;

  constructor(
    private clock: Clock,
    bpm = 124,
  ) {
    this.bpm_ = bpm;
  }

  get bpm(): number {
    return this.bpm_;
  }

  get playing(): boolean {
    return this.playing_;
  }

  get position(): number {
    return this.playing_ ? this.tickAt(this.clock.now()) : this.pauseTick;
  }

  get loopEnabled(): boolean {
    return this.loopEnabled_;
  }

  get loopStart(): number {
    return this.loopStart_;
  }

  /**
   * Loop end in absolute ticks. `0` means "to the end of the current content"
   * (the active pattern in pattern mode, or the arrangement end in song mode);
   * the scheduler resolves the concrete value based on the project model.
   */
  get loopEnd(): number {
    return this.loopEnd_;
  }

  play(fromTick = this.pauseTick): void {
    const now = this.clock.now();
    // When loop is enabled, snap the play start to loopStart so a manual
    // play from a position before the loop doesn't immediately wrap.
    const startTick = this.loopEnabled_ && fromTick < this.loopStart_ ? this.loopStart_ : fromTick;
    this.anchorTick = startTick;
    this.anchorTime = now;
    this.playing_ = true;
  }

  pause(): void {
    if (!this.playing_) return;
    this.pauseTick = this.tickAt(this.clock.now());
    this.playing_ = false;
  }

  stop(): void {
    this.playing_ = false;
    this.pauseTick = 0;
  }

  seek(tick: number): void {
    // Defensive guard: a NaN/Infinity/negative tick poisons tickAt() and the
    // scheduler's window endpoints forever. The diagnostics panel also
    // displays `transport.position`, so a stray bad value would surface to
    // the user as a meaningless "−NaN" tick. Clamp instead of crashing.
    if (!Number.isFinite(tick) || tick < 0) {
      console.warn(`[transport] ignored non-finite or negative seek: ${tick}`);
      return;
    }
    if (this.playing_) {
      this.anchorTick = tick;
      this.anchorTime = this.clock.now();
    } else {
      this.pauseTick = tick;
    }
  }

  setBpm(bpm: number): void {
    // setBpm is called on every onDocChanged (the project BPM is re-applied
    // each time the store mutates). A no-op rebase is harmless mathematically
    // (the resulting position is identical) but it is wasted work and
    // clutters the diagnostics trail. Skip the rebase when the value did
    // not actually change.
    if (Math.abs(bpm - this.bpm_) < 0.001) return;
    if (this.playing_) {
      const current = this.tickAt(this.clock.now());
      this.anchorTick = current;
      this.anchorTime = this.clock.now();
    }
    this.bpm_ = bpm;
  }

  /**
   * Re-anchor to an EXACT musical point (scene-tempo seam, roadmap 2.2):
   * the scheduler pre-computes the boundary's old-map wall time and snaps
   * the anchor onto it, so the post-boundary map continues the pre-scheduled
   * piecewise map with zero drift. `setBpm()` would re-anchor at the current
   * (tick-quantized) position instead — up to one tick of grid skip at the
   * seam. The playhead position snaps onto the boundary tick (≤ one tick of
   * movement), which is musically the more correct read.
   */
  setBpmAnchored(bpm: number, anchorTick: number, anchorTime: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    if (!Number.isFinite(anchorTick) || !Number.isFinite(anchorTime)) return;
    this.anchorTick = anchorTick;
    this.anchorTime = anchorTime;
    this.bpm_ = bpm;
  }

  /**
   * Configure the loop region. `end` is clamped to be `>= start` so a
   * degenerate range collapses to a single tick rather than wrapping
   * backwards. `end === 0` keeps the "to end of content" sentinel and is
   * resolved by the scheduler based on the project model.
   */
  setLoop(enabled: boolean, start: number, end: number): void {
    const safeStart = Math.max(0, Math.floor(start));
    const safeEnd = end > 0 ? Math.max(safeStart, Math.floor(end)) : 0;
    this.loopStart_ = safeStart;
    this.loopEnd_ = safeEnd;
    this.loopEnabled_ = enabled;
  }

  clearLoop(): void {
    this.loopEnabled_ = false;
    this.loopStart_ = 0;
    this.loopEnd_ = 0;
  }

  /** Count-in bars for recording (0/1/2). Persistent setting, not a doc field. */
  get countInBars(): number {
    return this.countInBars_;
  }

  setCountIn(bars: number): void {
    this.countInBars_ = Math.max(0, Math.min(2, Math.round(bars)));
  }

  /** Pre-roll bars (0/1) — playback begins this many bars before the requested tick. */
  get preRollBars(): number {
    return this.preRollBars_;
  }

  setPreRoll(bars: number): void {
    this.preRollBars_ = Math.max(0, Math.min(1, Math.round(bars)));
  }

  get secondsPerTick(): number {
    return 60 / (this.bpm_ * PPQ);
  }

  /**
   * Absolute tick where actual content (drums/notes) starts sounding during a
   * pre-roll playback — the count-in region [playStart, this) plays clicks only.
   */
  anchorTickBeforePreRoll(): number {
    return this.anchorTick + this.preRollBars_ * BAR_TICKS_;
  }

  tickAt(audioTime: number): number {
    return this.anchorTick + (audioTime - this.anchorTime) / this.secondsPerTick;
  }

  timeAtTick(tick: number): number {
    return this.anchorTime + (tick - this.anchorTick) * this.secondsPerTick;
  }
}
