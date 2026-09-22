/**
 * Live Note Repeat pad-mode — the MPC-style performance engine.
 *
 * Hold a pad (mouse, QWERTY key or MIDI note) and the pad re-fires on a
 * grid division (1/4 … 1/16T) with per-repeat velocity falloff. While the
 * transport plays, repeats lock to the transport tick grid so rolls land
 * quantized; while stopped they free-run on the audio clock at the current
 * tempo so fills can be rehearsed before recording.
 *
 * The controller is transport-agnostic and testable: callers inject a
 * Transport, the audio clock and a `fire` callback; scheduling is a pure
 * lookahead loop (25 ms tick, 120 ms horizon — same cadence as the
 * Scheduler).
 */
import { PPQ } from "../project-model/types";
import type { Transport } from "../transport/Transport";

export type RepeatRate = "off" | "1/4" | "1/8" | "1/16" | "1/8T" | "1/16T";
export type FalloffMode = "constant" | "decay" | "rise";

export const REPEAT_RATES: RepeatRate[] = ["off", "1/4", "1/8", "1/16", "1/8T", "1/16T"];
export const FALLOFF_MODES: FalloffMode[] = ["constant", "decay", "rise"];

/** Grid division in ticks. Triplets: PPQ/3 (1/8T) and PPQ/6 (1/16T). */
export function rateTicksOf(rate: Exclude<RepeatRate, "off">): number {
  switch (rate) {
    case "1/4":
      return PPQ;
    case "1/8":
      return PPQ / 2;
    case "1/16":
      return PPQ / 4;
    case "1/8T":
      return PPQ / 3;
    case "1/16T":
      return PPQ / 6;
  }
}

/** Per-repeat velocity. Decay/rise use a geometric curve; rise clamps at 1, decay floors at 0.05. */
export function repeatVelocity(base: number, index: number, mode: FalloffMode): number {
  const safeBase = Math.min(1, Math.max(0, base));
  if (mode === "decay") return Math.max(0.05, safeBase * Math.pow(0.85, index));
  if (mode === "rise") return Math.min(1, safeBase * Math.pow(1.15, index));
  return safeBase;
}

interface ActiveHold {
  trackId: string;
  padId: string;
  base: number;
  /** Hits fired so far (velocity index). */
  index: number;
  /** Live aftertouch (0..1) — raises the effective base, never lowers it. */
  pressure: number | null;
  /** This hold's division — inherited from the global default or pinned per pad. */
  rate: Exclude<RepeatRate, "off">;
  ratePinned: boolean;
  /** Next grid tick while the transport plays (null = needs re-anchor). */
  nextTick: number | null;
  /** Next audio-clock time while the transport is stopped (null otherwise). */
  nextTime: number | null;
}

const TICK_MS = 25;
const HORIZON_SECONDS = 0.12;
const AUDIBLE_EPSILON = 0.002;

export interface NoteRepeatDeps {
  getTransport(): Transport;
  getAudioTime(): number;
  /** Fire one pad hit. Implementations resolve the pad and schedule it. */
  fire(trackId: string, padId: string, velocity: number, when: number): void;
  /** Optional host gesture hooks; note repeat itself does not own document history. */
  beginUndoFrame?: (label?: string) => void;
  endUndoFrame?: () => void;
}

export class NoteRepeatController {
  private holds = new Map<string, ActiveHold>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private rate: RepeatRate = "off";
  private falloff: FalloffMode = "decay";

  constructor(private deps: NoteRepeatDeps) {}

  get currentRate(): RepeatRate {
    return this.rate;
  }

  get currentFalloff(): FalloffMode {
    return this.falloff;
  }

  get size(): number {
    return this.holds.size;
  }

  isHolding(key: string): boolean {
    return this.holds.has(key);
  }

  setRate(rate: RepeatRate): void {
    this.rate = rate;
    if (rate === "off") {
      this.stopAll();
      return;
    }
    // Re-anchor every hold that INHERITS the global division so the new
    // default takes effect on its next repeat. Per-pad pinned holds keep
    // their own rate (that is what pinning means).
    for (const key of [...this.holds.keys()]) {
      const hold = this.holds.get(key)!;
      if (hold.ratePinned) continue;
      hold.rate = rate;
      this.anchor(hold, key);
    }
  }

  setFalloff(mode: FalloffMode): void {
    this.falloff = mode;
  }

  /**
   * Live pressure (MIDI aftertouch, 0..1) for one hold. It raises the hold's
   * effective base — `max(noteOnVelocity, pressure)` — so squeezing a pad
   * makes the repeats louder, and a RISING squeeze restarts the falloff
   * curve (squeeze = re-energize the roll). Sub-note-on pressure never
   * REDUCES velocity: soft hits stay soft until you actually squeeze.
   */
  setHoldPressure(key: string, pressure: number): void {
    const hold = this.holds.get(key);
    if (!hold) return;
    const clamped = Math.min(1, Math.max(0, pressure));
    const prevEffective = hold.pressure !== null ? Math.max(hold.base, hold.pressure) : hold.base;
    const newEffective = Math.max(hold.base, clamped);
    if (newEffective > prevEffective) hold.index = 0;
    hold.pressure = clamped;
  }

  /** Hold keys sharing a namespace prefix (e.g. `midi:10:` for a channel). */
  holdKeysWithPrefix(prefix: string): string[] {
    const keys: string[] = [];
    for (const key of this.holds.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  /**
   * Pad-down. Fires the first hit immediately (index 0 = `base` velocity),
   * then repeats on the grid while held. Callers must pair with `stop(key)`.
   * `pinnedRate` gives THIS hold its own division (kick 1/16 while the hat
   * rolls 1/8T); without it the hold inherits the global default.
   */
  start(key: string, trackId: string, padId: string, base: number, pinnedRate?: Exclude<RepeatRate, "off">): void {
    if (this.rate === "off") {
      // Still fire the single hit so callers can route every pad-down here.
      this.deps.fire(trackId, padId, Math.min(1, Math.max(0, base)), this.deps.getAudioTime() + 0.005);
      return;
    }
    const now = this.deps.getAudioTime();
    const hold: ActiveHold = {
      trackId,
      padId,
      base,
      index: 0,
      pressure: null,
      rate: pinnedRate ?? this.rate,
      ratePinned: pinnedRate !== undefined,
      nextTick: null,
      nextTime: null,
    };
    this.holds.set(key, hold);
    this.deps.fire(trackId, padId, repeatVelocity(base, 0, this.falloff), now + 0.005);
    hold.index = 1;
    this.anchor(hold, key);
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }
  }

  /** Pad-up — the key stops repeating. Already-scheduled hits (≤ horizon) play out. */
  stop(key: string): void {
    this.holds.delete(key);
    this.pruneTimer();
  }

  stopAll(): void {
    this.holds.clear();
    this.pruneTimer();
  }

  /**
   * Re-anchor every held roll to the transport's CURRENT position (Audit 03
   * D2). A seek or loop wrap used to leave `nextTick` pointing past the old
   * location: the roll went mute until the playhead climbed back to that
   * stale grid tick (up to a full loop pass), and forward seeks burned
   * stale grid points before resuming. Clearing `nextTick` makes the next
   * tick() re-anchor from the live position — the same sentinel the
   * playing↔stopped transition already uses.
   */
  reanchorToTransport(): void {
    for (const hold of this.holds.values()) {
      hold.nextTick = null;
      hold.nextTime = null;
    }
  }

  /**
   * Pad-up every hold whose key shares a namespace prefix (e.g. all
   * `midi:` holds when a controller disconnects mid-hold — its note-off
   * will never arrive, so the roll must not outlive the device). UI holds
   * (`pad:`, key holds) are unaffected.
   */
  stopWithPrefix(prefix: string): void {
    for (const key of [...this.holds.keys()]) {
      if (key.startsWith(prefix)) this.holds.delete(key);
    }
    this.pruneTimer();
  }

  private anchor(hold: ActiveHold, _key: string): void {
    const transport = this.deps.getTransport();
    const rateTicks = rateTicksOf(hold.rate);
    if (transport.playing) {
      const position = Math.max(0, transport.position);
      hold.nextTick = (Math.floor(position / rateTicks) + 1) * rateTicks;
      hold.nextTime = null;
    } else {
      hold.nextTime = this.deps.getAudioTime() + rateTicks * transport.secondsPerTick;
      hold.nextTick = null;
    }
  }

  private tick(): void {
    if (this.holds.size === 0 || this.rate === "off") return;
    const transport = this.deps.getTransport();
    const now = this.deps.getAudioTime();
    const horizon = now + HORIZON_SECONDS;
    for (const hold of this.holds.values()) {
      const rateTicks = rateTicksOf(hold.rate);
      const rateSec = rateTicks * transport.secondsPerTick;
      // Aftertouch raises the effective base; it never reduces velocity below
      // the note-on hit (`max`), so soft hits stay soft until squeezed.
      const base = hold.pressure !== null ? Math.max(hold.base, hold.pressure) : hold.base;
      if (transport.playing) {
        if (hold.nextTick === null) {
          // Was free-running (transport started mid-hold) — re-anchor to grid.
          const position = Math.max(0, transport.position);
          hold.nextTick = (Math.floor(position / rateTicks) + 1) * rateTicks;
          hold.nextTime = null;
        }
        // The horizon can hold several repeats at fast rates — drain them all.
        for (let guard = 0; guard < 64; guard++) {
          const when = transport.timeAtTick(hold.nextTick!);
          if (when > horizon) break;
          if (when >= now - AUDIBLE_EPSILON) {
            this.deps.fire(hold.trackId, hold.padId, repeatVelocity(base, hold.index, this.falloff), when);
            hold.index += 1;
          }
          hold.nextTick! += rateTicks;
        }
      } else {
        if (hold.nextTime === null) {
          hold.nextTime = now + rateSec;
          hold.nextTick = null;
        }
        while (hold.nextTime! <= horizon) {
          this.deps.fire(hold.trackId, hold.padId, repeatVelocity(base, hold.index, this.falloff), hold.nextTime!);
          hold.index += 1;
          hold.nextTime! += rateSec;
        }
      }
    }
  }

  private pruneTimer(): void {
    if (this.holds.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
