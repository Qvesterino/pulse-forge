import { PPQ } from "../project-model/types";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => performance.now() / 1000 };

/** Default ticks per bar (4/4). Projects can provide their actual bar length. */
const BAR_TICKS_ = PPQ * 4;
const MIN_BPM = 20;
const MAX_BPM = 300;
const FALLBACK_BPM = 120;

function clampTransportBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

export class Transport {
  private bpm_: number;
  private playing_ = false;
  private anchorTick = 0;
  private anchorTime = 0;
  private pauseTick = 0;
  private paused_ = false;
  /** Absolute tick at which content becomes audible for the current play. */
  private contentStartTick_ = 0;
  /** Bar length used when calculating a future count-in/pre-roll. */
  private barTicks_ = BAR_TICKS_;
  private loopEnabled_ = false;
  private loopStart_ = 0;
  private loopEnd_ = 0;
  /** Metronome count-in length in bars (0 = off, 1..2). */
  private countInBars_ = 0;
  /** Pre-roll length in bars (0 = off, 1) — playback starts this many bars early. */
  private preRollBars_ = 0;
  /** Metronome click during content playback (runtime preference, not a doc field). */
  private metronome_ = false;
  /**
   * User-gesture hook (collab transport sync): fires after every
   * user-visible transport change (play/pause/stop/seek) with the
   * post-change transport, so an outside listener can broadcast the new
   * anchor. Programmatic re-anchoring by the sync itself must guard with
   * its own lock — see openProject's follow logic.
   */
  onGesture: ((transport: Transport) => void) | null = null;

  constructor(
    private clock: Clock,
    bpm = 124,
  ) {
    this.bpm_ = Number.isFinite(bpm) ? clampTransportBpm(bpm) : FALLBACK_BPM;
  }

  get bpm(): number {
    return this.bpm_;
  }

  get playing(): boolean {
    return this.playing_;
  }

  /** True after pause and false after stop; used to avoid repeating count-in on resume. */
  get paused(): boolean {
    return this.paused_;
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

  /**
   * Start playback. A local start gets the configured click lead-in unless
   * the transport is resuming from pause or the caller explicitly disables
   * it (remote sync and other already-timed surfaces).
   */
  play(fromTick = this.pauseTick, options: { leadIn?: boolean } = {}): void {
    // Negative finite ticks are intentional for count-in/pre-roll; non-finite
    // anchors poison the transport time map and every later scheduler window.
    if (!Number.isFinite(fromTick)) return;
    const now = this.clock.now();
    // When loop is enabled, snap the play start to loopStart so a manual
    // play from a position before the loop doesn't immediately wrap.
    const startTick = this.loopEnabled_ && fromTick < this.loopStart_ ? this.loopStart_ : fromTick;
    this.anchorTick = startTick;
    this.anchorTime = now;
    const useLeadIn = !this.paused_ && options.leadIn !== false;
    this.contentStartTick_ = startTick + (useLeadIn ? this.leadInBars() * this.barTicks_ : 0);
    this.playing_ = true;
    this.paused_ = false;
    this.onGesture?.(this);
  }

  pause(): void {
    if (!this.playing_) return;
    this.pauseTick = this.tickAt(this.clock.now());
    this.playing_ = false;
    this.paused_ = true;
    this.onGesture?.(this);
  }

  stop(): void {
    // Always gesture: a stop while paused still rewinds to 0 and the jam
    // peers must follow the rewind even though `playing` did not change.
    this.playing_ = false;
    this.pauseTick = 0;
    this.paused_ = false;
    this.contentStartTick_ = 0;
    this.onGesture?.(this);
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
      // A seek is an explicit new playback location; it must not introduce
      // another count-in or pre-roll before the requested content.
      this.contentStartTick_ = tick;
    } else {
      this.pauseTick = tick;
    }
    this.onGesture?.(this);
  }

  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm)) return;
    const nextBpm = clampTransportBpm(bpm);
    // setBpm is called on every onDocChanged (the project BPM is re-applied
    // each time the store mutates). A no-op rebase is harmless mathematically
    // (the resulting position is identical) but it is wasted work and
    // clutters the diagnostics trail. Skip the rebase when the value did
    // not actually change.
    if (Math.abs(nextBpm - this.bpm_) < 0.001) return;
    if (this.playing_) {
      const current = this.tickAt(this.clock.now());
      this.anchorTick = current;
      this.anchorTime = this.clock.now();
    }
    this.bpm_ = nextBpm;
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
    this.bpm_ = clampTransportBpm(bpm);
  }

  /**
   * Configure the loop region. `end` is clamped to be `>= start` so a
   * degenerate range collapses to a single tick rather than wrapping
   * backwards. `end === 0` keeps the "to end of content" sentinel and is
   * resolved by the scheduler based on the project model.
   */
  setLoop(enabled: boolean, start: number, end: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
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
    if (!Number.isFinite(bars)) return;
    this.countInBars_ = Math.max(0, Math.min(2, Math.round(bars)));
  }

  /** Metronome click while the transport plays (0/1 bars are count-in/pre-roll only). */
  get metronome(): boolean {
    return this.metronome_;
  }

  setMetronome(enabled: boolean): void {
    this.metronome_ = !!enabled;
  }

  /** Pre-roll bars (0/1) — playback begins this many bars before the requested tick. */
  get preRollBars(): number {
    return this.preRollBars_;
  }

  setPreRoll(bars: number): void {
    if (!Number.isFinite(bars)) return;
    this.preRollBars_ = Math.max(0, Math.min(1, Math.round(bars)));
  }

  /**
   * Set the project's musical bar length for future count-in/pre-roll starts.
   * The default keeps standalone transports and legacy callers in 4/4.
   * Changing it during an active lead-in does not move that play's boundary.
   */
  setBarTicks(ticks: number): void {
    if (Number.isFinite(ticks) && ticks > 0) this.barTicks_ = ticks;
  }

  /**
   * Total lead-in bars before content sounds: the pre-roll region PLUS the
   * count-in bars (FL/Cubase semantics — "C1" counts one bar of clicks before
   * the content starts; pre-roll adds a bar of clicks on top of it).
   * `playPause` starts the transport this many bars early, the scheduler
   * clicks every beat inside the lead-in, and content stays untouched.
   */
  leadInBars(): number {
    return this.preRollBars_ + this.countInBars_;
  }

  /** Total lead-in duration in ticks for the configured project bar length. */
  leadInTicks(): number {
    return this.leadInBars() * this.barTicks_;
  }

  get secondsPerTick(): number {
    return 60 / (this.bpm_ * PPQ);
  }

  /** Absolute tick where the content region begins (end of the click lead-in). */
  anchorTickBeforePreRoll(): number {
    return this.playing_ ? this.contentStartTick_ : this.anchorTick + this.leadInBars() * this.barTicks_;
  }

  tickAt(audioTime: number): number {
    return this.anchorTick + (audioTime - this.anchorTime) / this.secondsPerTick;
  }

  timeAtTick(tick: number): number {
    return this.anchorTime + (tick - this.anchorTick) * this.secondsPerTick;
  }
}
