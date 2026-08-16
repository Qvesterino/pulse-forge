import { PPQ } from "../project-model/types";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => performance.now() / 1000 };

export class Transport {
  private bpm_: number;
  private playing_ = false;
  private anchorTick = 0;
  private anchorTime = 0;
  private pauseTick = 0;
  private loopEnabled_ = false;
  private loopStart_ = 0;
  private loopEnd_ = 0;

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
    const startTick =
      this.loopEnabled_ && fromTick < this.loopStart_ ? this.loopStart_ : fromTick;
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
    if (this.playing_) {
      this.anchorTick = tick;
      this.anchorTime = this.clock.now();
    } else {
      this.pauseTick = tick;
    }
  }

  setBpm(bpm: number): void {
    if (this.playing_) {
      const current = this.tickAt(this.clock.now());
      this.anchorTick = current;
      this.anchorTime = this.clock.now();
    }
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

  get secondsPerTick(): number {
    return 60 / (this.bpm_ * PPQ);
  }

  tickAt(audioTime: number): number {
    return this.anchorTick + (audioTime - this.anchorTime) / this.secondsPerTick;
  }

  timeAtTick(tick: number): number {
    return this.anchorTime + (tick - this.anchorTick) * this.secondsPerTick;
  }
}
