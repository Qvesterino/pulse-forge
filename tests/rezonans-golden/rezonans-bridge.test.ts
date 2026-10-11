/**
 * REZONANS — the key/chord bridge (ADR 0040 §4.3).
 *
 * This is the first test in the repo that proves PROJECT MUSICAL CONTEXT
 * reaches the audio thread. Before it, `doc.key` was metadata only — its own
 * docstring said "display + scorepack" and nothing in `src/audio-engine/`
 * read it — and `pitchCorrect`'s key params had no writer at all.
 *
 * Three claims, each pinned against the interval tables rather than against a
 * hand-written bitmask, because a mask that disagrees with the piano roll is
 * exactly the failure this bridge exists to prevent.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  CHROMATIC_MASK,
  chordMaskFor,
  maskFromIntervals,
  resolveHarmonyContext,
  scaleMaskForKey,
} from "../../src/audio-engine/harmonyContext";
import { CHORD_INTERVALS, type ChordQuality } from "../../src/project-model/chords";
import { SCALE_INTERVALS, formatKey, type ScaleType } from "../../src/project-model/scales";
import type { MusicalKey } from "../../src/project-model/types";
import { RezonansProcessor } from "../../src/effects/rezonans-core/dsp/rezonansProcessor.js";
import { QUALITY_BALANCED, QUALITY_ECONOMY, REZ_PARAM } from "../../src/effects/rezonans-core/contracts/parameters.js";
import { EFFECT_KNOB, effectWordIn } from "../../src/intent/mix";

const SCALE_TYPES = Object.keys(SCALE_INTERVALS) as ScaleType[];
const QUALITIES = Object.keys(CHORD_INTERVALS) as ChordQuality[];

interface PostedLatency {
  type?: string;
  samples?: number;
}

class WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: PostedLatency[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message as PostedLatency);
  }
}

class WorkletProcessorBase {
  port = new WorkletPort();
}

interface RezonansWorklet {
  port: WorkletPort;
  process(inputs: Float32Array[][] | [], outputs: Float32Array[][]): boolean;
}

type RezonansWorkletCtor = new (options?: {
  processorOptions?: { params?: Record<string, number> };
}) => RezonansWorklet;

let RegisteredRezonansWorklet: RezonansWorkletCtor;
let workletNow = 0;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48_000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = WorkletProcessorBase;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (
    name: string,
    ctor: RezonansWorkletCtor,
  ) => {
    if (name === "rezonans-processor") RegisteredRezonansWorklet = ctor;
  };
  Object.defineProperty(globalThis, "currentTime", {
    get: () => workletNow,
    configurable: true,
  });
  // @ts-expect-error the worklet entry is an untyped classic-script source
  await import("../../src/effects/rezonans-worklet.entry.js");
  if (!RegisteredRezonansWorklet) throw new Error('registerProcessor("rezonans-processor") did not run');
});

describe("REZONANS bridge — mask derivation matches the interval tables", () => {
  it("every scale type produces a mask containing exactly its intervals", () => {
    for (const scale of SCALE_TYPES) {
      for (let root = 0; root < 12; root++) {
        const expected = SCALE_INTERVALS[scale].reduce((m, i) => m | (1 << ((root + i) % 12)), 0);
        const { rootPc, mask } = scaleMaskForKey(formatKey(root, scale));
        expect(rootPc, `${scale} root ${root}`).toBe(root);
        expect(mask, `${scale} root ${root}`).toBe(expected);
      }
    }
  });

  it("every chord quality produces a mask containing exactly its intervals", () => {
    for (const quality of QUALITIES) {
      for (let root = 0; root < 12; root++) {
        const expected = CHORD_INTERVALS[quality].reduce((m, i) => m | (1 << ((root + i) % 12)), 0);
        expect(chordMaskFor(root, quality), `${quality} root ${root}`).toBe(expected);
      }
    }
  });

  it("C major triad is {C, E, G} and moves with the root", () => {
    expect(chordMaskFor(0, "maj")).toBe((1 << 0) | (1 << 4) | (1 << 7));
    expect(chordMaskFor(2, "maj")).toBe((1 << 2) | (1 << 6) | (1 << 9)); // D F# A
  });

  it("a mask built from interval 0 is the single root bit", () => {
    // The `%`-before-`<<` precedence trap: `1 << root % 12` would mask the
    // SHIFTED value instead of the root.
    for (let root = 0; root < 12; root++) {
      expect(maskFromIntervals(root, [0])).toBe(1 << root);
    }
  });
});

describe("REZONANS worklet — quality automation latency reporting", () => {
  it("reports the new latency when a time-stamped quality event takes effect", () => {
    workletNow = 0;
    const proc = new RegisteredRezonansWorklet({
      processorOptions: { params: { [REZ_PARAM.quality]: QUALITY_ECONOMY } },
    });
    const latencyReports = () => proc.port.posted.filter((message) => message.type === "latency");
    expect(latencyReports().map((message) => message.samples)).toEqual([1023]);

    proc.port.onmessage?.({
      data: { type: "paramAt", id: REZ_PARAM.quality, value: QUALITY_BALANCED, when: 0.003 },
    });
    const input = [new Float32Array(128), new Float32Array(128)];
    const output = [[new Float32Array(128), new Float32Array(128)]];
    proc.process([input], output);
    workletNow = 128 / 48_000;
    proc.process([input], output);

    expect(latencyReports().map((message) => message.samples)).toEqual([1023, 2047]);
  });
});

describe("REZONANS bridge — safe degradation", () => {
  it("no document yields no context", () => {
    expect(resolveHarmonyContext(undefined)).toBeUndefined();
    expect(resolveHarmonyContext(null)).toBeUndefined();
  });

  it("no key is chromatic, not silently C major", () => {
    const ctx = resolveHarmonyContext({});
    expect(ctx?.scaleMask).toBe(CHROMATIC_MASK);
    expect(ctx?.keyRootPc).toBe(0);
    expect(ctx?.chords).toEqual([]);
  });

  it("a malformed chord event is skipped, not thrown", () => {
    const ctx = resolveHarmonyContext({
      arrangement: {
        chords: [
          { startBar: 0, lengthBars: 4, root: 0, quality: "maj" },
          { startBar: Number.NaN, lengthBars: 4, root: 2, quality: "min" },
          { startBar: 8, lengthBars: 0, root: 4, quality: "maj" },
          { startBar: 8, lengthBars: 4, root: 5, quality: "min" },
        ],
      },
    });
    expect(ctx?.chords).toHaveLength(2);
    expect(ctx?.chords.map((c) => c.startBar)).toEqual([0, 8]);
  });

  it("the chord lane is sorted by absolute bar", () => {
    const ctx = resolveHarmonyContext({
      arrangement: {
        chords: [
          { startBar: 16, lengthBars: 4, root: 7, quality: "maj" },
          { startBar: 0, lengthBars: 8, root: 0, quality: "min" },
          { startBar: 8, lengthBars: 8, root: 5, quality: "maj" },
        ],
      },
    });
    expect(ctx?.chords.map((c) => c.startBar)).toEqual([0, 8, 16]);
  });
});

describe("REZONANS bridge — the processor follows the chord lane by bar", () => {
  it("chordTones resolves a different target in bar 0 vs bar 4", () => {
    const ctx = resolveHarmonyContext({
      key: "C Major" as MusicalKey,
      arrangement: {
        chords: [
          { startBar: 0, lengthBars: 4, root: 0, quality: "maj" }, // C E G
          { startBar: 4, lengthBars: 4, root: 7, quality: "maj" }, // G B D
        ],
      },
    });
    expect(ctx).toBeDefined();

    const probe = (bpm: number, seconds: number): number => {
      const proc = new RezonansProcessor();
      proc.prepare(48000, 2, 128, bpm);
      proc.setParameter(REZ_PARAM.harmonyMode, 3); // chordTones
      proc.setHarmonyContext(ctx!);
      proc.prepareOfflineRender();
      const frames = Math.floor(seconds * 48000);
      const block = [new Float32Array(128), new Float32Array(128)];
      for (let i = 0; i < frames; i += 128) {
        block[0].fill(0);
        block[1].fill(0);
        proc.process(block, 128);
      }
      return proc.getMeters().chordPc;
    };

    // 4 bars at 120 BPM = 8 s. Probe the middle of bar 0 and the middle of
    // bar 5 (8.33 s in) to sit unambiguously inside each chord.
    const first = probe(120, 2);
    const second = probe(120, 8.5);
    expect(first).toBe(0);
    expect(second).toBe(7);
  });

  it("before the first chord the mask falls back to the scale", () => {
    const ctx = resolveHarmonyContext({
      key: "C Major" as MusicalKey,
      arrangement: { chords: [{ startBar: 4, lengthBars: 4, root: 0, quality: "maj" }] },
    });
    const proc = new RezonansProcessor();
    proc.prepare(48000, 2, 128, 120);
    proc.setParameter(REZ_PARAM.harmonyMode, 3);
    proc.setHarmonyContext(ctx!);
    proc.prepareOfflineRender();
    const block = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 128 * 30; i += 128) {
      block[0].fill(0);
      block[1].fill(0);
      proc.process(block, 128);
    }
    // Still inside bar 0 — the lane starts at bar 4.
    expect(proc.getMeters().chordPc).toBe(-1);
  });
});

describe("REZONANS — the panel reads the solver, not a re-derivation", () => {
  it("voiceMidi carries the resolved targets, and -1 before anything is sung", () => {
    const proc = new RezonansProcessor();
    proc.prepare(48000, 2, 128, 120);
    proc.setParameter(REZ_PARAM.harmonyMode, 2);
    proc.setParameter("voice0.degree", 4);
    proc.prepareOfflineRender();

    // Silence: nothing has been solved, so the panel must draw "waiting"
    // rather than a note at MIDI 0 (8.2 Hz — a pitch nobody can sing).
    const silent = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 40; i++) proc.process(silent, 128);
    expect(proc.getMeters().voiceMidi.slice()).toEqual([-1, -1, -1, -1]);

    // A held tone: YIN locks, the solver resolves, and the meter mirrors it.
    const f0 = 220;
    const singerMidi = 69 + 12 * Math.log2(f0 / 440);
    const voiced = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 128 * 60; i += 128) {
      for (let n = 0; n < 128; n++) {
        const s = Math.sin((2 * Math.PI * f0 * (i + n)) / 48000) * 0.4;
        voiced[0]![n] = s;
        voiced[1]![n] = s;
      }
      proc.process(voiced, 128);
    }
    const m = proc.getMeters();
    expect(m.f0).toBeGreaterThan(180);
    expect(m.f0).toBeLessThan(260);
    // The contract is "a real, resolved target" — NOT "above the singer". The
    // solver picks the NEAREST instance of the scale degree, so a 5th can land
    // below the singer; asserting "above" would be asserting my assumption
    // about octave placement, not the product.
    for (const midi of m.voiceMidi) expect(midi).toBeGreaterThan(0);
    // What must hold: the voice is a genuine harmony note, not a unison copy.
    expect(Math.abs(m.voiceMidi[0]! - singerMidi)).toBeGreaterThan(1);
  });

  it("an octave is reachable in both modes — neither silently returns unison", () => {
    const singerMidi = 69 + 12 * Math.log2(220 / 440);
    const solveWith = (mode: number, degree: number): number => {
      const proc = new RezonansProcessor();
      proc.prepare(48000, 2, 128, 120);
      proc.setParameter(REZ_PARAM.harmonyMode, mode);
      proc.setParameter("voice0.degree", degree);
      proc.prepareOfflineRender();
      const block = [new Float32Array(128), new Float32Array(128)];
      for (let i = 0; i < 128 * 60; i += 128) {
        for (let n = 0; n < 128; n++) {
          const s = Math.sin((2 * Math.PI * 220 * (i + n)) / 48000) * 0.4;
          block[0]![n] = s;
          block[1]![n] = s;
        }
        proc.process(block, 128);
      }
      return proc.getMeters().voiceMidi[0]!;
    };

    // INTERVAL 12 is a semitone count and must land an exact octave up. This
    // used to route through the pitch-class search, whose nearest instance for
    // the singer's OWN pitch class is the note being sung.
    expect(Math.round(solveWith(1, 12) - singerMidi)).toBe(12);
    // DEGREES beyond the scale length must still resolve to a real harmony
    // note — the failure being guarded is "silently became a unison doubling",
    // not "landed below the singer" (which is musically normal).
    const wrapped = solveWith(2, 9);
    expect(Math.abs(wrapped - singerMidi)).toBeGreaterThan(1);
  });

  it("reset() clears the targets so a restarted render draws no stale note", () => {
    const proc = new RezonansProcessor();
    proc.prepare(48000, 2, 128, 120);
    proc.setParameter(REZ_PARAM.harmonyMode, 2);
    const voiced = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 128 * 60; i += 128) {
      for (let n = 0; n < 128; n++) {
        const s = Math.sin((2 * Math.PI * 220 * (i + n)) / 48000) * 0.4;
        voiced[0]![n] = s;
        voiced[1]![n] = s;
      }
      proc.process(voiced, 128);
    }
    expect(proc.getMeters().voiceMidi.some((v) => v > 0)).toBe(true);
    proc.reset();
    expect(proc.getMeters().voiceMidi.slice()).toEqual([-1, -1, -1, -1]);
  });
});

describe("REZONANS — the intent aliases reach the right device", () => {
  it("routes the brand and the technical word to REZONANS", () => {
    expect(effectWordIn(" pridaj rezonans na lead ")).toBe("rezonans");
    expect(effectWordIn(" daj viac formantu na vocals ")).toBe("rezonans");
  });

  it("does not steal GROW's harmony words, and leaves the growth knob alone", () => {
    // EFFECT_WORDS is scanned in order, so a new alias placed AFTER the GROW
    // stems can never win — this pins that ordering, because swapping the two
    // would silently send every bass-harmonic request to the wrong device.
    expect(effectWordIn(" viac harmoniky na bass ")).toBe("bassHarmonic");
    expect(effectWordIn(" bass harmonic generator ")).toBe("bassHarmonic");
    expect(EFFECT_KNOB.rezonans).toBe("formant");
  });
});
