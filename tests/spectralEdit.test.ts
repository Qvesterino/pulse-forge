import { describe, expect, it } from "vitest";
import { applySpectralEdits, computeStftDbFrames, fftInPlace, suggestNoiseRegion, suggestNoiseRegionFromFrames } from "../src/audio-engine/spectralEdit";

const SR = 44100;

function sine(freqHz: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR);
  return out;
}

function rms(x: Float32Array, fromSec = 0, toSec = x.length / SR): number {
  const from = Math.max(0, Math.floor(fromSec * SR));
  const to = Math.min(x.length, Math.ceil(toSec * SR));
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** The nearest exactly-on-bin frequency for the default 2048 window. */
function onBinFreq(bin: number): number {
  return (bin * SR) / 2048;
}

describe("fftInPlace", () => {
  it("round-trips a signal through forward and inverse transform", () => {
    const n = 256;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const ref = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.37) + 0.2 * Math.cos(i * 1.1);
      ref[i] = re[i];
    }
    fftInPlace(re, im);
    // Spectral sanity: DC bin holds the mean of the input.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += ref[i];
    expect(re[0]).toBeCloseTo(mean, 6);
    fftInPlace(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(ref[i], 9);
  });

  it("rejects non-power-of-two sizes", () => {
    const re = new Float64Array(100);
    const im = new Float64Array(100);
    expect(() => fftInPlace(re, im)).toThrow(/power of two/);
  });
});

describe("applySpectralEdits — reconstruction", () => {
  it("passes audio through untouched when the edit list is empty", () => {
    const input = sine(440, 0.5);
    const out = applySpectralEdits(input, SR, []);
    expect(out.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 97) expect(out[i]).toBeCloseTo(input[i], 5);
  });

  it("reconstructs an unedited region near-exactly (WOLA identity)", () => {
    const input = sine(440, 1);
    // Edit far outside the signal? No — edit NOTHING: a band the signal
    // never touches still must not alter the samples.
    const out = applySpectralEdits(input, SR, [
      { startSec: 0, endSec: 1, freqLoHz: 8000, freqHiHz: 12000, gainDb: -60 },
    ]);
    for (let i = 0; i < input.length; i += 97) expect(out[i]).toBeCloseTo(input[i], 4);
  });
});

describe("applySpectralEdits — selectivity", () => {
  it("attenuates a tone inside the band and leaves an out-of-band tone alone", () => {
    // Bin 46 ≈ 990.5 Hz sits inside 900–1100; bin 20 ≈ 430.7 Hz sits below
    // the feather reach (900 / 2^0.25 ≈ 756 Hz).
    const inBand = sine(onBinFreq(46), 1.5);
    const outBand = sine(onBinFreq(20), 1.5);

    const editedIn = applySpectralEdits(inBand, SR, [
      { startSec: 0, endSec: 1.5, freqLoHz: 900, freqHiHz: 1100, gainDb: -60 },
    ]);
    const editedOut = applySpectralEdits(outBand, SR, [
      { startSec: 0, endSec: 1.5, freqLoHz: 900, freqHiHz: 1100, gainDb: -60 },
    ]);

    const ratioIn = rms(editedIn, 0.2, 1.3) / rms(inBand, 0.2, 1.3);
    const ratioOut = rms(editedOut, 0.2, 1.3) / rms(outBand, 0.2, 1.3);
    expect(ratioIn).toBeLessThan(0.05); // −26 dB or better after feather/leakage
    expect(ratioOut).toBeGreaterThan(0.98);
    expect(ratioOut).toBeLessThan(1.02);
  });

  it("limits the edit to its time window", () => {
    const freq = onBinFreq(46);
    const input = sine(freq, 2);
    const out = applySpectralEdits(input, SR, [
      { startSec: 0.5, endSec: 1.0, freqLoHz: 400, freqHiHz: 1600, gainDb: -60 },
    ]);
    const during = rms(out, 0.62, 0.88) / rms(input, 0.62, 0.88);
    const after = rms(out, 1.3, 1.7) / rms(input, 1.3, 1.7);
    expect(during).toBeLessThan(0.05);
    expect(after).toBeGreaterThan(0.98);
    expect(after).toBeLessThan(1.02);
  });

  it("boosts a band by the requested gain", () => {
    const freq = onBinFreq(30);
    const input = sine(freq, 1);
    const out = applySpectralEdits(input, SR, [
      { startSec: 0, endSec: 1, freqLoHz: 400, freqHiHz: 800, gainDb: 6 },
    ]);
    const ratio = rms(out, 0.25, 0.75) / rms(input, 0.25, 0.75);
    expect(ratio).toBeGreaterThan(1.7); // ~+6 dB ≈ ×2, feather trims a little
    expect(ratio).toBeLessThan(2.1);
  });

  it("never emits NaN or Inf, even with stacked overlapping edits", () => {
    const input = sine(220, 0.8);
    const out = applySpectralEdits(
      input,
      SR,
      [
        { startSec: 0, endSec: 0.5, freqLoHz: 100, freqHiHz: 500, gainDb: -24 },
        { startSec: 0.25, endSec: 0.8, freqLoHz: 200, freqHiHz: 1000, gainDb: 6 },
        { startSec: 0.1, endSec: 0.6, freqLoHz: 50, freqHiHz: 20000, gainDb: -48 },
      ],
      { featherSec: 0.01 },
    );
    for (let i = 0; i < out.length; i += 13) {
      expect(Number.isFinite(out[i])).toBe(true);
    }
  });
});

describe("suggestNoiseRegion — erase-noise preset", () => {
  function noise(seconds: number, amp = 0.05, lowpass = false): Float32Array {
    const n = Math.round(seconds * SR);
    const out = new Float32Array(n);
    let prev = 0;
    let seed = 1234567;
    for (let i = 0; i < n; i++) {
      // Deterministic LCG-based white noise.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const white = ((seed / 0x3fffffff) - 1) * amp;
      out[i] = lowpass ? (prev = prev + 0.12 * (white - prev)) : white;
    }
    return out;
  }

  it("suggests a broadband region for white noise", () => {
    const clip = noise(1.2);
    const sug = suggestNoiseRegion(clip, SR, 1.2);
    expect(sug).not.toBeNull();
    // White noise is flat across the spectrum — the band must span most of it.
    const span = sug!.freqHiHz / sug!.freqLoHz;
    expect(sug!.freqLoHz).toBeLessThan(200);
    expect(sug!.freqHiHz).toBeGreaterThan(SR / 2 / 3);
    expect(span).toBeGreaterThan(20);
    expect(sug!.gainDb).toBe(-48);
    expect(sug!.startSec).toBe(0);
  });

  it("returns null for pure silence", () => {
    const clip = new Float32Array(Math.round(1.0 * SR));
    expect(suggestNoiseRegion(clip, SR, 1.0)).toBeNull();
  });

  it("keeps the suggestion tight around a lone persistent tone", () => {
    const clip = sine(onBinFreq(46), 1.2);
    const sug = suggestNoiseRegion(clip, SR, 1.2);
    expect(sug).not.toBeNull();
    // The tone's band must not blanket the whole spectrum.
    expect(sug!.freqLoHz).toBeGreaterThan(600);
    expect(sug!.freqHiHz).toBeLessThan(1600);
  });

  it("places a low-passed hiss suggestion in the low region, not the top octave", () => {
    const clip = noise(1.2, 0.08, true); // one-pole lowpass → energy below ~1.2 kHz
    const sug = suggestNoiseRegion(clip, SR, 1.2);
    expect(sug).not.toBeNull();
    expect(sug!.freqHiHz).toBeLessThan(SR / 4);
    expect(sug!.freqLoHz).toBeLessThan(400);
  });

  it("suggestNoiseRegionFromFrames agrees with the wrapper", () => {
    const clip = noise(1.0);
    const frames = computeStftDbFrames(clip, 2048, 1024);
    expect(frames.length).toBeGreaterThan(4);
    const direct = suggestNoiseRegionFromFrames(frames, SR, 2048, 1.0);
    const wrapped = suggestNoiseRegion(clip, SR, 1.0);
    expect(direct).toEqual(wrapped);
  });
});
