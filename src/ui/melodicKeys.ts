import type { AudioEngine } from "../audio-engine/AudioEngine";

/**
 * Melodic QWERTY player (Instant Jam: a joiner without a MIDI controller
 * becomes a musician in three seconds).
 *
 * Layout is the tracker/Ableton standard: A=C, W=C#, S=D, E=D#, D=E, F=F,
 * T=F#, G=G, Y=G#, H=A, U=A#, J=B, then K/O/L/P/; continue the next octave.
 * Z/X shift the octave. Keys SUSTAIN while held — runtimes that implement
 * noteOff release on key-up; the rest play their natural note duration.
 *
 * This only engages on INSTRUMENT tracks: drum tracks have their own
 * rebindable pad keys (padKeys.ts) and they own the letter rows there.
 */

export const MELODIC_OFFSETS: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
};

const BASE_PITCH = 60; // C4
const OCTAVE_MIN = -3;
const OCTAVE_MAX = 3;
const DEFAULT_VELOCITY = 0.8;
/** Safety duration for runtimes without noteOff — the note dies on its own. */
const FALLBACK_DURATION = 4;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

export interface MelodicKeysHost {
  engine: AudioEngine;
  /** The selected track id when it is an instrument track, else null. */
  getInstrumentTrackId(): string | null;
}

export class MelodicKeys {
  private octave = 0;
  /** code → the exact pitch that was sounded on key-down. */
  private held = new Map<string, number>();
  private host: MelodicKeysHost | null = null;

  bind(host: MelodicKeysHost): void {
    this.host = host;
  }

  getOctave(): number {
    return this.octave;
  }

  /** Keys currently held (live display hook). */
  heldCount(): number {
    return this.held.size;
  }

  /**
   * Optional listener for performed notes (Instant Jam: the AI bandmate
   * listens to these — noteHeard).
   */
  onPlayed: ((pitch: number, velocity: number) => void) | null = null;
  /** Note released — record-to-pattern pairs this with the played pitch. */
  onReleased: ((pitch: number) => void) | null = null;

  /**
   * Step-entry mode owns the letter keys — while suppressed, live play yields
   * to the piano-roll editor. Any held notes release immediately so a toggle
   * mid-hold never hangs a voice.
   */
  private suppressed = false;
  setSuppressed(value: boolean): void {
    this.suppressed = value;
    if (value) {
      const host = this.host;
      for (const [, pitch] of this.held) {
        const trackId = host?.getInstrumentTrackId();
        if (host && trackId) host.engine.noteOff(trackId, pitch, host.engine.currentTime + 0.005);
      }
      this.held.clear();
    }
  }

  /**
   * Handle a keydown. Returns true when the key was consumed as a musical
   * input (caller should preventDefault so shortcuts stay silent).
   */
  keydown(event: {
    code: string;
    repeat?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    target?: EventTarget | null;
  }): boolean {
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (isTypingTarget(event.target ?? null)) return false;
    if (this.suppressed) return false;
    const host = this.host;
    if (!host) return false;

    if (event.code === "KeyZ") {
      this.octave = Math.max(OCTAVE_MIN, this.octave - 1);
      return true;
    }
    if (event.code === "KeyX") {
      this.octave = Math.min(OCTAVE_MAX, this.octave + 1);
      return true;
    }

    const offset = MELODIC_OFFSETS[event.code];
    if (offset === undefined) return false;
    const trackId = host.getInstrumentTrackId();
    if (!trackId) return false; // drum tracks play pads, not notes
    if (this.held.has(event.code)) return true; // already sounding

    const pitch = Math.max(0, Math.min(127, BASE_PITCH + this.octave * 12 + offset));
    this.held.set(event.code, pitch);
    host.engine.noteOn(trackId, pitch, DEFAULT_VELOCITY, host.engine.currentTime + 0.005, FALLBACK_DURATION);
    this.onPlayed?.(pitch, DEFAULT_VELOCITY);
    return true;
  }

  /** Handle a key-up: release the exact pitch that key-down sounded. */
  keyup(event: { code: string }): boolean {
    const pitch = this.held.get(event.code);
    if (pitch === undefined) return false;
    this.held.delete(event.code);
    const host = this.host;
    if (host) {
      const trackId = host.getInstrumentTrackId();
      if (trackId) host.engine.noteOff(trackId, pitch, host.engine.currentTime + 0.005);
    }
    this.onReleased?.(pitch);
    return true;
  }
}

/** App-lifetime player instance (window listeners bind once). */
export const melodicKeys = new MelodicKeys();
