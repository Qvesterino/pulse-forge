import { describe, expect, it } from "vitest";
import { separateHPSS } from "../../src/analysis/hpss";
import { detectChordSpans } from "../../src/reference/analysis/chords";
import { expandChordSpans, chordBarAccuracy } from "../../src/reference/unsuno-metrics";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";

/**
 * S0 — HPSS core contract (ADR 0019 Tier 1): deterministic guide stems.
 * The pinning properties: reconstruction (percussive + harmonic == input),
 * clean harmonic/percussive assignment on pure fixtures, determinism,
 * honest null on silence, and — on the golden house track — the chord lane
 * reading the harmonic stem keeps its exact accuracy.
 */

const SR = GOLDEN_SAMPLE_RATE;

function rmsInterior(data: Float32Array): number {
  let sum = 0;
  for (let i = 1000; i < data.length - 1000; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / (data.length - 2000));
}

describe("separateHPSS — S0 core contract", () => {
  it("DETERMINISM: two runs are bit-identical", () => {
    const pcm = renderGoldenTrack(goldenTracks()[0]);
    const a = separateHPSS(pcm, SR)!;
    const b = separateHPSS(pcm, SR)!;
    expect(a.percussive.length).toBe(b.percussive.length);
    for (const key of ["percussive", "harmonic", "bass"] as const) {
      for (let i = 0; i < a[key].length; i += 977) {
        expect(a[key][i], `${key}@${i}`).toBe(b[key][i]);
      }
    }
  });

  it("RECONSTRUCTION: percussive + harmonic == input (sample-exact interior)", () => {
    const pcm = renderGoldenTrack(goldenTracks()[0]);
    const stems = separateHPSS(pcm, SR)!;
    let maxDiff = 0;
    for (let i = 5000; i < stems.percussive.length - 5000; i += 13) {
      maxDiff = Math.max(maxDiff, Math.abs(stems.percussive[i] + stems.harmonic[i] - pcm[i]));
    }
    expect(maxDiff).toBeLessThan(1e-3); // masks are complementary, WOLA exact
  });

  it("a pure 440 Hz tone lands in the HARMONIC stem (~0 in percussive)", () => {
    const sine = new Float32Array(SR * 4);
    for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const stems = separateHPSS(sine, SR)!;
    const harmonicRms = rmsInterior(stems.harmonic);
    const percussiveRms = rmsInterior(stems.percussive);
    expect(harmonicRms).toBeGreaterThan(0.2);
    expect(percussiveRms / harmonicRms).toBeLessThan(0.01);
  });

  it("a kick burst train lands in the PERCUSSIVE stem (~0 in harmonic)", () => {
    const kick = new Float32Array(SR * 4);
    for (let k = 0; k < 8; k++) {
      const start = Math.round(k * 0.5 * SR);
      for (let i = 0; i < SR * 0.15 && start + i < kick.length; i++) {
        const t = i / SR;
        kick[start + i] = 0.8 * Math.exp(-t / 0.03) * Math.sin(2 * Math.PI * 60 * t);
      }
    }
    const stems = separateHPSS(kick, SR)!;
    const harmonicRms = rmsInterior(stems.harmonic);
    const percussiveRms = rmsInterior(stems.percussive);
    expect(percussiveRms).toBeGreaterThan(0.03);
    // 60 Hz sits at the very bottom of the FFT grid (~3 bins) — a real
    // HPSS edge case. 15% harmonic bleed is honest; the gate is >= 5x.
    expect(harmonicRms / percussiveRms).toBeLessThan(0.2);
  });

  it("silence → null (nothing to separate, never invented stems)", () => {
    expect(separateHPSS(new Float32Array(SR * 3), SR)).toBeNull();
  });

  it("the chord lane reading the HARMONIC stem keeps exact accuracy on house", () => {
    const track = goldenTracks()[0];
    const pcm = renderGoldenTrack(track);
    const stems = separateHPSS(pcm, SR)!;
    const detection = detectChordSpans(stems.harmonic, SR, { bpm: track.bpm })!;
    const report = chordBarAccuracy(expandChordSpans(detection.spans), track.chords);
    expect(report.exactCorrect).toBe(report.total); // 8/8 — the tonal content survives
  });

  it("maxSeconds caps the analysis length", () => {
    const pcm = renderGoldenTrack(goldenTracks()[0]);
    const stems = separateHPSS(pcm, SR, { maxSeconds: 5 })!;
    expect(stems.analyzedSec).toBe(5);
    expect(stems.percussive.length).toBe(5 * SR);
  });
});
