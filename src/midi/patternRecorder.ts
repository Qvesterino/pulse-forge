import { addNote, prepareRecordPattern, setStepVelocityCommand } from "../commands/commands";
import type { Command } from "../commands/types";
import { STEP_TICKS } from "../project-model/types";
import type { ProjectDocument } from "../project-model/types";

export type RecordQuantize = "off" | "16th" | "8th";
export type RecordMode = "overdub" | "replace";

export interface PatternRecorderSnapshot {
  /** Record armed — incoming performed notes land in the active pattern. */
  armed: boolean;
  mode: RecordMode;
  quantize: RecordQuantize;
  /** 0..1 — how far a note pulls toward the grid (1 = full snap, 0 = free). */
  strength: number;
}

export interface PatternRecorderDeps {
  getDoc: () => ProjectDocument;
  execute: (command: Command) => void;
  /** Musical tick for an event that just arrived (maps audio time → transport tick). */
  getTick: () => number;
  isPlaying: () => boolean;
  /** Content-region start (post count-in/pre-roll) while playing; null/absent = no gate. */
  getContentStartTick?: () => number | null;
  /** Undo frame — the whole record pass collapses into ONE history entry. */
  beginUndoFrame: (label?: string) => void;
  endUndoFrame: () => void;
}

const QUANTIZE_TICKS: Record<RecordQuantize, number> = {
  off: 0,
  "16th": STEP_TICKS,
  "8th": STEP_TICKS * 2,
};

/**
 * Live MIDI record-to-pattern (FL-style overdub).
 *
 * While armed, performed drum hits stamp their step row and performed
 * instrument notes commit on note-off into the ACTIVE pattern at the
 * transport's musical tick — pattern-length aware (a take across the loop
 * wrap lands back into the pattern). REPLACE mode clears the performed
 * surfaces once when armed; OVERDUB (default) merges with what is there.
 *
 * Hooked from MidiInput (instrument notes), the NoteRepeat fire callback
 * (every performed drum hit — single or repeat) and the transport stop path
 * (held notes flush as step-length notes so nothing is lost mid-note).
 */
export class PatternRecorder {
  private deps: PatternRecorderDeps;
  private state: PatternRecorderSnapshot = { armed: false, mode: "overdub", quantize: "off", strength: 1 };
  private listeners = new Set<() => void>();
  /** Held instrument notes: pitch → note-on info (raw, unquantized start). */
  private held = new Map<number, { trackId: string; startTick: number; velocity: number }>();
  /** REPLACE clear already ran for the current arm — it must run once per pass. */
  private replaceCleared = false;

  constructor(deps: PatternRecorderDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PatternRecorderSnapshot => this.state;

  private setState(patch: Partial<PatternRecorderSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  setMode = (mode: RecordMode): void => {
    this.setState({ mode });
    // Switching into REPLACE while armed clears right away — predictable:
    // what you see in the pattern is what the take will build on.
    if (mode === "replace" && this.state.armed && !this.replaceCleared) this.runReplaceClear();
  };

  setQuantize = (quantize: RecordQuantize): void => {
    this.setState({ quantize });
  };

  setStrength = (strength: number): void => {
    this.setState({ strength: Math.max(0, Math.min(1, strength)) });
  };

  /**
   * Arm/disarm. The whole pass lives in ONE undo frame — REPLACE clear plus
   * every recorded hit/note collapse into a single history entry. Disarming
   * flushes held notes as step-length notes and seals the frame.
   */
  setArmed = (armed: boolean): void => {
    if (armed === this.state.armed) return;
    this.setState({ armed });
    this.replaceCleared = false;
    if (!armed) {
      this.flushHeld();
      this.deps.endUndoFrame();
      return;
    }
    this.deps.beginUndoFrame("Recorded take");
    if (this.state.mode === "replace") this.runReplaceClear();
  };

  /**
   * Transport stopped/paused — held notes flush as step-length notes and the
   * pass's frame seals. Staying armed opens a fresh frame for the next pass
   * (each loop of the take is its own undo, REPLACE cleared only at arm).
   */
  onTransportInterrupted = (): void => {
    this.flushHeld();
    this.deps.endUndoFrame();
    if (this.state.armed) this.deps.beginUndoFrame("Recorded take");
  };

  /**
   * Musical tick for a performed event — or null when the event must NOT be
   * recorded (Audit 07 D2/D3). A STOPPED transport extrapolates getTick()
   * from a stale anchor, so notes landed at drifting pseudo-random steps;
   * count-in/pre-roll ticks land one lead-in early. Both are dropped: the
   * hit still sounds (the fire callback is separate), it just doesn't stamp
   * the pattern.
   */
  private captureTick(): number | null {
    if (!this.deps.isPlaying()) return null;
    const contentStart = this.deps.getContentStartTick?.();
    const tick = this.deps.getTick();
    if (contentStart !== null && contentStart !== undefined && tick < contentStart) return null;
    return tick;
  }

  /** One performed drum hit — stamps the (wrapped) step row immediately. */
  drumHit = (padId: string, velocity: number): void => {
    if (!this.state.armed) return;
    const tick = this.captureTick();
    if (tick === null) return;
    if (this.state.mode === "replace" && !this.replaceCleared) this.runReplaceClear();
    const doc = this.deps.getDoc();
    const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
    const stepCount = pattern?.stepCount ?? 16;
    const step = Math.floor(this.quantizeTick(tick) / STEP_TICKS);
    const wrapped = ((step % stepCount) + stepCount) % stepCount;
    this.deps.execute(setStepVelocityCommand(doc, padId, wrapped, velocity));
  };

  /** Instrument note-on — remembers the start tick; commits on note-off. */
  noteOn = (trackId: string, pitch: number, velocity: number): void => {
    if (!this.state.armed) return;
    const tick = this.captureTick();
    if (tick === null) return;
    if (this.state.mode === "replace" && !this.replaceCleared) this.runReplaceClear();
    this.held.set(pitch, { trackId, startTick: tick, velocity });
  };

  /** Instrument note-off — commits the note with its played duration. */
  noteOff = (pitch: number): void => {
    const held = this.held.get(pitch);
    if (!held) return;
    this.held.delete(pitch);
    this.commitNote(held.trackId, pitch, held.startTick, this.deps.getTick(), held.velocity);
  };

  /** Transport stopped/disarmed mid-note — held notes become step-length. */
  private flushHeld(): void {
    for (const [pitch, held] of this.held) {
      this.commitNote(held.trackId, pitch, held.startTick, held.startTick + STEP_TICKS, held.velocity);
    }
    this.held.clear();
  }

  private commitNote(trackId: string, pitch: number, rawStart: number, rawEnd: number, velocity: number): void {
    const doc = this.deps.getDoc();
    const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
    if (!pattern) return;
    const patternTicks = Math.max(STEP_TICKS, pattern.stepCount * STEP_TICKS);
    // Wrap into the pattern: a take across the loop end lands back at the top.
    const start = ((this.quantizeTick(rawStart) % patternTicks) + patternTicks) % patternTicks;
    const rawDuration = Math.round(rawEnd - rawStart);
    const duration = Math.min(Math.max(STEP_TICKS, rawDuration), patternTicks - start);
    if (duration < 1) return;
    this.deps.execute(addNote(doc, trackId, { pitch, start, duration, velocity }));
  }

  private quantizeTick(tick: number): number {
    const raw = Math.max(0, Math.round(tick));
    const grid = QUANTIZE_TICKS[this.state.quantize];
    if (grid <= 0) return raw;
    // Strength interpolates toward the grid: 1 = full snap, 0.5 = halfway
    // (the classic "quantize strength" — keeps some human feel).
    const snapped = Math.round(raw / grid) * grid;
    return Math.max(0, Math.round(raw + (snapped - raw) * this.state.strength));
  }

  private runReplaceClear(): void {
    this.replaceCleared = true;
    this.deps.execute(prepareRecordPattern(this.deps.getDoc()));
  }
}
