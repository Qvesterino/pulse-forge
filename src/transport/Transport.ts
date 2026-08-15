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

  play(fromTick = this.pauseTick): void {
    const now = this.clock.now();
    this.anchorTick = fromTick;
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
