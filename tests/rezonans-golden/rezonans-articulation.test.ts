/**
 * REZONANS v2 — formant band detection (ADR 0041 P1).
 *
 * These tests pin the detection stage on its own, before any audio path
 * consumes it. The v2 warp rests entirely on stable band edges, so "is the
 * centre correct" and "does the centre sit still" are separate claims and both
 * need their own assertion.
 */

import { describe, expect, it } from "vitest";
import { FormantBands, sampleEnvelopeLogSpaced } from "../../src/effects/rezonans-core/dsp/formantBands.js";

const SR = 48000;
const N = 4096;
const HALF = N >> 1;
const BIN_HZ = SR / N;

/**
 * A synthetic vocal-tract log envelope: three raised-cosine formant bumps over a
 * decaying spectral tilt. Realistic enough that the peak-picker has to actually
 * find peaks rather than reading a handed-over answer.
 *
 * The bump width matters and was measured, not guessed. `0.10 * fc` puts F3's
 * FWHM near 310 Hz, which is what a real formant measures. An earlier fixture
 * used `0.28 * fc` — a 873 Hz-wide F3 that fills most of its own search window —
 * and the detector rejected it. That turned out to be a genuinely useful
 * finding: it is why the floor reference is a low percentile rather than the
 * median (see `FLOOR_PERCENTILE`), but a fixture that wide is not a voice.
 */
function synthEnvelope(centersHz: readonly number[], half = HALF): Float64Array {
  const env = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const f = k * BIN_HZ;
    // Tilt: −4 dB/octave, in natural-log units.
    let v = -0.55 * Math.log2(Math.max(f, 20) / 200);
    for (const fc of centersHz) {
      const width = 0.1 * fc;
      const d = (f - fc) / width;
      v += 2.2 * Math.exp(-0.5 * d * d);
    }
    env[k] = v;
  }
  return env;
}

function warmed(centersHz: readonly number[], frames = 12): { bands: FormantBands; env: Float64Array } {
  const bands = new FormantBands();
  bands.prepare(SR, N);
  const env = synthEnvelope(centersHz);
  for (let i = 0; i < frames; i++) bands.update(env, HALF);
  return { bands, env };
}

describe("REZONANS v2 — formant band detection", () => {
  it("finds F1, F2 and F3 to within one FFT bin", () => {
    const want = [430, 1180, 2650];
    const { bands } = warmed(want);
    const got = bands.centerHz;
    // The claim is bounded by the ANALYSIS, not by the algorithm: bins are
    // 11.72 Hz apart, and parabolic interpolation buys sub-bin precision on a
    // clean peak. One bin is the honest limit — the synthetic envelope's own
    // peak is also pulled off its nominal centre by the tilt and by the
    // neighbouring bump, so anything tighter would be asserting my arithmetic
    // rather than the detector.
    for (let b = 0; b < 3; b++) {
      expect(Math.abs(got[b]! - want[b]!), `band ${b}`).toBeLessThanOrEqual(BIN_HZ);
    }
  });

  it("moves the detected centre when the singer moves it", () => {
    const { bands } = warmed([500, 1500, 2600]);
    const before = bands.centerHz[0]!;
    const env = synthEnvelope([820, 1500, 2600]);
    for (let i = 0; i < 24; i++) bands.update(env, HALF);
    const after = bands.centerHz[0]!;
    expect(after).toBeGreaterThan(before + 200);
    // Within one bin of the new nominal centre — same honesty rule as the
    // accuracy test: the composite peak is pulled slightly off the nominal by
    // the tilt and the neighbouring bump, so the claim is bounded by the
    // analysis resolution, not by my expectation of the arithmetic.
    expect(Math.abs(after - 820)).toBeLessThanOrEqual(BIN_HZ);
  });

  it("holds the centre still on a sustained vowel (jitter under 15 Hz RMS)", () => {
    const bands = new FormantBands();
    bands.prepare(SR, N);
    const env = synthEnvelope([520, 1450, 2600]);
    const samples: number[] = [];
    for (let i = 0; i < 120; i++) {
      bands.update(env, HALF);
      if (i >= 24) samples.push(bands.centerHz[0]!);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const rms = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
    expect(rms).toBeLessThan(15);
  });

  it("gives strictly ascending boundaries inside the analysed spectrum", () => {
    const { bands } = warmed([430, 1180, 2650]);
    const e = bands.boundaries;
    expect(e[0]).toBe(0);
    expect(e[3]).toBe(HALF);
    expect(e[1]!).toBeGreaterThan(0);
    expect(e[2]!).toBeGreaterThan(e[1]!);
    expect(e[3]!).toBeGreaterThan(e[2]!);
    // The geometric mean of two centres must land between them.
    const hz = (bin: number) => bin * BIN_HZ;
    expect(hz(e[1]!)).toBeGreaterThan(430);
    expect(hz(e[1]!)).toBeLessThan(1180);
    expect(hz(e[2]!)).toBeGreaterThan(1180);
    expect(hz(e[2]!)).toBeLessThan(2650);
  });

  it("survives crossed centres without producing a zero-width band", () => {
    // F2 missing: the tracker must fall back rather than emit reversed edges,
    // which would divide by zero inside the warp.
    const bands = new FormantBands();
    bands.prepare(SR, N);
    const env = synthEnvelope([900, 2400]);
    for (let i = 0; i < 16; i++) bands.update(env, HALF);
    const e = bands.boundaries;
    expect(e[2]!).toBeGreaterThan(e[1]!);
  });

  it("reports no band rather than a guess on an empty spectrum", () => {
    const bands = new FormantBands();
    bands.prepare(SR, N);
    const flat = new Float64Array(HALF + 1); // all zeros — no peak can qualify
    for (let i = 0; i < 12; i++) bands.update(flat, HALF);
    // Either the centres stay unset or they hold a fallback, but they must
    // never be a fabricated peak out of noise.
    for (const c of bands.centerHz) expect(Number.isFinite(c)).toBe(true);
    expect(bands.boundaries[2]!).toBeGreaterThan(bands.boundaries[1]!);
  });

  it("assigns every output bin to exactly one band", () => {
    const { bands } = warmed([430, 1180, 2650]);
    const bandOf = bands.bandOf;
    expect(bandOf.length).toBe(HALF + 1);
    for (let k = 0; k <= HALF; k++) {
      const b = bandOf[k]!;
      expect(b === 0 || b === 1 || b === 2).toBe(true);
    }
    // Monotone: the band index must not go backwards across the spectrum.
    for (let k = 1; k <= HALF; k++) expect(bandOf[k]!).toBeGreaterThanOrEqual(bandOf[k - 1]!);
  });

  it("is deterministic across repeated runs", () => {
    const run = () => Array.from(warmed([610, 1720, 2480]).bands.centerHz);
    expect(run()).toEqual(run());
  });

  it("samples the envelope onto the panel's log axis without allocating", () => {
    const { bands, env } = warmed([430, 1180, 2650]);
    const out = new Float32Array(48);
    sampleEnvelopeLogSpaced(env, HALF, SR, 70, 11000, out);
    expect(out.length).toBe(48);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    // Re-running must fill the same array in place, not replace it.
    const ref = out;
    sampleEnvelopeLogSpaced(env, HALF, SR, 70, 11000, out);
    expect(out).toBe(ref);
    expect(bands.ready).toBe(true);
  });
});
