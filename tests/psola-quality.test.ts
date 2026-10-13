import { describe, expect, it } from "vitest";
import { psolaShiftPitch } from "../src/vocal/psola";

/**
 * PSOLA QUALITY MEASUREMENTS (KROK 3 of HUM A HIT) — the reason TD-PSOLA
 * exists: pitch shift with the SPECTRAL ENVELOPE (formants) preserved.
 * The roadmap's acceptance bar: spectral centroid drift < 10 % at +12 st.
 *
 * The measurement fixture is a harmonic hum with a formant BUMP — harmonics
 * whose amplitudes follow a resonance peaked near 900 Hz. That bump is the
 * proxy formant: resample-by-ratio moves it 1:1 with the pitch (centroid
 * doubles at +12 st), while PSOLA keeps the envelope and the bump stays.
 */

const SR = 44100;

/** Harmonic hum at hz with a resonance bump near 900 Hz. */
function formantHum(hz: number, seconds: number): Float32Array {
  const length = Math.floor(seconds * SR);
  const audio = new Float32Array(length);
  const harmonics = [1, 2, 3, 4, 5, 6, 7, 8];
  const bump = (k: number): number => {
    const f = hz * k;
    return 1 + 3 * Math.exp(-Math.pow((f - 900) / 300, 2));
  };
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const edge = Math.min(1, Math.min(t, 1 - t) * 10);
    let value = 0;
    for (const k of harmonics) value += (0.5 / k) * bump(k) * Math.sin((2 * Math.PI * hz * k * i) / SR);
    audio[i] = value * edge;
  }
  return audio;
}

/** Spectral centroid over the whole signal (FFT, no windowing tricks). */
function spectralCentroid(samples: Float32Array): number {
  const N = 16384;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  if (peak <= 0) return 0;
  for (let i = 0; i < N && i < samples.length; i++) {
    re[i] = (samples[i] / peak) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
  let num = 0;
  let den = 0;
  for (let k = 1; k < N / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    num += mag * (k * (SR / N));
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

describe("PSOLA formant preservation (KROK 3 measurements)", () => {
  const hum = formantHum(220, 2); // A3, formant bump ~900 Hz
  const shifted = psolaShiftPitch(hum, SR, 2)!; // +12 st
  const originalCentroid = spectralCentroid(hum);
  const psolaCentroid = spectralCentroid(shifted);

  it("the centroid drift at +12 st stays under the 10 % bar", () => {
    const drift = Math.abs(psolaCentroid - originalCentroid) / originalCentroid;
    expect(
      drift,
      `psola centroid ${psolaCentroid.toFixed(0)} vs original ${originalCentroid.toFixed(0)} Hz`,
    ).toBeLessThan(0.1);
  });

  it("the shifted output is non-silent and covers the span", () => {
    expect(shifted.length).toBe(hum.length);
    let peak = 0;
    for (const v of shifted) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
  });
});
