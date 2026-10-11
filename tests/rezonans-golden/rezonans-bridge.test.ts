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

import { describe, expect, it } from "vitest";
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
import { REZ_PARAM } from "../../src/effects/rezonans-core/contracts/parameters.js";

const SCALE_TYPES = Object.keys(SCALE_INTERVALS) as ScaleType[];
const QUALITIES = Object.keys(CHORD_INTERVALS) as ChordQuality[];

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
