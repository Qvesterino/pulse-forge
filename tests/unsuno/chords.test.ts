import { describe, expect, it } from "vitest";
import { deriveKeyFromChords, detectChordSpans, type ChordSpan } from "../../src/reference/analysis/chords";
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

describe("deriveKeyFromChords — U1.5 sequence key", () => {
  const span = (startBar: number, bars: number, rootPc: number, quality: ChordSpan["quality"]): ChordSpan => ({
    startBar,
    bars,
    rootPc,
    quality,
    confidence: 0.4,
  });
  const conf = (derived: { tonicPc: number; mode: string } | null, tonicPc: number, mode: string): boolean =>
    derived !== null && derived.tonicPc === tonicPc && derived.mode === mode;

  it("i VI III VII (Gm Eb Bb F) → G minor, not the Bb-major rotation", () => {
    const derived = deriveKeyFromChords(
      [span(0, 2, 7, "min"), span(2, 2, 3, "maj"), span(4, 2, 10, "maj"), span(6, 2, 5, "maj")],
      8,
    );
    expect(conf(derived, 7, "minor")).toBe(true);
    expect(derived!.confidence).toBeGreaterThan(0.5);
  });
  it("a one-chord minor drone reads MINOR (mode match breaks the rotation tie)", () => {
    const derived = deriveKeyFromChords([span(0, 8, 4, "min")], 8);
    expect(conf(derived, 4, "minor")).toBe(true);
  });
  it("too little evidence (single short span) → null", () => {
    expect(deriveKeyFromChords([span(0, 1, 0, "maj")], 1)).toBeNull();
    expect(deriveKeyFromChords([], 8)).toBeNull();
  });
  it("off-scale chords eat the evidence — chromatic nonsense → low confidence", () => {
    const derived = deriveKeyFromChords(
      [span(0, 2, 0, "maj"), span(2, 2, 1, "maj"), span(4, 2, 6, "min"), span(6, 2, 11, "maj")],
      8,
    );
    // C, C#, F#, B — no diatonic scale holds this; whatever wins must be weak.
    expect(derived!.confidence).toBeLessThan(0.9);
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
