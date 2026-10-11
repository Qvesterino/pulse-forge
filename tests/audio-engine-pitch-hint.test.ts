import { describe, expect, it } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";

/**
 * AudioEngine pitch hints (GROW/KOREŇ `hintHz`).
 *
 * The host knows which MIDI note a track is playing, so noteOn/noteOff drive
 * the `hintHz` AudioParam on the track's inserts: the effect gets zero
 * acquisition latency and no octave risk, and falls back to pure YIN at 0.
 * `hintHz` is native AudioParam automation (`setValueAtTime` at the event's
 * own `when`), so live and offline renders receive identical hints; inserts
 * without the parameter ignore the write inside their node wrapper.
 */

type Write = [string, number, number];

function withRuntimes(engine: AudioEngine, trackId: string, writes: Write[]): void {
  const runtime = {
    setParameterAt: (id: string, value: number, when: number) => writes.push([id, value, when]),
  };
  (engine as unknown as { trackNodes: Map<string, unknown> }).trackNodes.set(trackId, {
    fx: { runtimes: new Map([["fx-grow", runtime]]) },
  });
}

describe("AudioEngine pitch hints (hintHz)", () => {
  it("noteOn/noteOff drive hintHz on the track's inserts, most-recent note wins", () => {
    const engine = new AudioEngine();
    const writes: Write[] = [];
    withRuntimes(engine, "bass", writes);

    engine.noteOn("bass", 69, 1, 1.0, 0.5); // A2 = 440 Hz
    expect(writes.at(-1)?.[0]).toBe("hintHz");
    expect(writes.at(-1)?.[1]).toBeCloseTo(440, 2);
    expect(writes.at(-1)?.[2]).toBe(1.0); // the event's own `when` — offline-safe

    engine.noteOn("bass", 76, 1, 1.1, 0.5); // E3 = 659.26 Hz
    expect(writes.at(-1)?.[1]).toBeCloseTo(659.26, 1);

    engine.noteOff("bass", 76, 1.3); // release the top → previous held note
    expect(writes.at(-1)?.[1]).toBeCloseTo(440, 2);

    engine.noteOff("bass", 69, 1.5); // nothing held → hint 0 (pure YIN)
    expect(writes.at(-1)?.[1]).toBe(0);
  });

  it("panic releases every hint so the next note re-hints from scratch", () => {
    const engine = new AudioEngine();
    const writes: Write[] = [];
    withRuntimes(engine, "bass", writes);

    engine.noteOn("bass", 69, 1, 0, 0.5);
    engine.panic(); // bare engine: no context — internal state must still clear
    engine.noteOn("bass", 71, 1, 0, 0.5); // B3 = 493.88 Hz, NOT a fallback to 69
    expect(writes.at(-1)?.[1]).toBeCloseTo(493.88, 1);
  });

  it("tracks without fx runtimes (or unknown tracks) stay silent and safe", () => {
    const engine = new AudioEngine();
    expect(() => engine.noteOn("missing", 69, 1, 0, 0.5)).not.toThrow();
    expect(() => engine.noteOff("missing", 69, 0.5)).not.toThrow();
    // A track whose chain has no hint-capable runtime: the push is stored,
    // the write is skipped — no throw, no state leak into other tracks.
    const writes: Write[] = [];
    withRuntimes(engine, "bass", writes);
    engine.noteOn("keys", 60, 1, 0, 0.5);
    expect(writes.length).toBe(0);
  });
});
