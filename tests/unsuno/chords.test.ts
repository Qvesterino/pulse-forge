import { describe, expect, it } from "vitest";
import { detectChordSpans } from "../../src/reference/analysis/chords";
import { expandChordSpans } from "../../src/reference/unsuno-metrics";

/**
 * U1 unit layer — pure detection behaviour on minimal synthetic signals
 * (the genre-level KPI lives in golden-set.test.ts against the full synth).
 * Track-level determinism is locked there; these tests pin the CONTRACT:
 * silence → no opinion, clean voicing → confident span, half-time grids
 * reconcile through time.
 */

const SR = 44100;

/** One sustained chord from a triad voicing at C4 — pure sines, nothing else. */
function chordPcm(midis: number[], seconds: number): Float32Array {
  const pcm = new Float32Array(Math.ceil(SR * seconds));
  for (const midi of midis) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    for (let i = 0; i < pcm.length; i++) pcm[i] += 0.2 * Math.sin((2 * Math.PI * f0 * i) / SR);
  }
  return pcm;
}

describe("detectChordSpans — pure contract", () => {
  it("silence → null (no tempo grid no opinion, but explicit input guards too)", () => {
    expect(detectChordSpans(new Float32Array(SR), SR, { bpm: 120 })).toBeNull();
    expect(detectChordSpans(new Float32Array(SR * 4), SR, { bpm: 0 })).toBeNull();
    expect(detectChordSpans(new Float32Array(SR * 4), SR, { bpm: Number.NaN })).toBeNull();
  });

  it("a clean C major triad for 4 bars → one span, C major, high confidence", () => {
    // C4/E4/G4 + C2 bass fundamental, 4 bars at 120 BPM = 8 s.
    const pcm = chordPcm([36, 60, 64, 67], 8);
    const detection = detectChordSpans(pcm, SR, { bpm: 120 });
    expect(detection).not.toBeNull();
    expect(detection!.barsAnalyzed).toBe(4);
    expect(detection!.spans).toHaveLength(1);
    const span = detection!.spans[0];
    expect(span.startBar).toBe(0);
    expect(span.bars).toBe(4);
    expect(span.rootPc).toBe(0);
    expect(span.quality).toBe("maj");
    expect(span.confidence).toBeGreaterThan(0.1);
  });

  it("the SAME signal twice → bit-identical spans (determinism)", () => {
    const pcm = chordPcm([36, 57, 60, 64], 6); // A minor voicing
    const a = detectChordSpans(pcm, SR, { bpm: 90 });
    const b = detectChordSpans(pcm, SR, { bpm: 90 });
    expect(a).toEqual(b);
  });

  it("grid too fast to be meaningful → null", () => {
    expect(detectChordSpans(new Float32Array(SR * 4), SR, { bpm: 2000 })).toBeNull();
  });
});

describe("expandChordSpans — grid reconciliation", () => {
  it("1:1 by default", () => {
    const detected = expandChordSpans([{ startBar: 0, bars: 2, rootPc: 9, quality: "min" }]);
    expect(detected).toEqual([
      { bar: 0, rootPc: 9, quality: "min" },
      { bar: 1, rootPc: 9, quality: "min" },
    ]);
  });
  it("half-time spans (2× long) map onto two truth bars through time", () => {
    // Detected at 90 BPM (bar = 2.667 s) vs truth at 180 BPM (bar = 1.333 s).
    const detected = expandChordSpans([{ startBar: 0, bars: 1, rootPc: 7, quality: "min" }], {
      spanBarSec: 240 / 90,
      truthBarSec: 240 / 180,
      totalBars: 2,
    });
    expect(detected).toEqual([
      { bar: 0, rootPc: 7, quality: "min" },
      { bar: 1, rootPc: 7, quality: "min" },
    ]);
  });
  it("bars no span covers stay absent (misses, not guesses)", () => {
    const detected = expandChordSpans([{ startBar: 2, bars: 1, rootPc: 0, quality: "maj" }], {
      totalBars: 4,
    });
    expect(detected).toEqual([{ bar: 2, rootPc: 0, quality: "maj" }]);
  });
});
