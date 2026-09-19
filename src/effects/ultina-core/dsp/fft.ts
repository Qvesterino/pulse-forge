/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Shared FFT Utilities
//
// Radix-2 Cooley-Tukey FFT with Hanning window.
// Used by featureExtractor, tonalBalance, and any analysis
// code that needs a magnitude spectrum.
// ═══════════════════════════════════════════════════════════

export function applyHanningWindow(frame: Float32Array): void {
  const n = frame.length;
  for (let i = 0; i < n; i++) {
    frame[i] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
}

export function computeMagnitudeSpectrum(frame: Float32Array): Float32Array {
  const n = frame.length;
  const half = n / 2;

  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    real[i] = frame[i];
  }

  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
    let k = half;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  for (let stage = 1; stage < n; stage <<= 1) {
    const halfStage = stage;
    const stage2 = stage << 1;
    const angleStep = -Math.PI / halfStage;
    const wCos = Math.cos(angleStep);
    const wSin = Math.sin(angleStep);

    for (let group = 0; group < n; group += stage2) {
      let wRe = 1.0;
      let wIm = 0.0;
      for (let pair = 0; pair < halfStage; pair++) {
        const idx1 = group + pair;
        const idx2 = idx1 + halfStage;
        const tRe = wRe * real[idx2] - wIm * imag[idx2];
        const tIm = wRe * imag[idx2] + wIm * real[idx2];
        real[idx2] = real[idx1] - tRe;
        imag[idx2] = imag[idx1] - tIm;
        real[idx1] += tRe;
        imag[idx1] += tIm;

        const newWRe = wRe * wCos - wIm * wSin;
        wIm = wRe * wSin + wIm * wCos;
        wRe = newWRe;
      }
    }
  }

  const result = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    result[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
  }

  return result;
}

export function bandEnergy(magnitudes: Float32Array, sampleRate: number, freqLow: number, freqHigh: number): number {
  const binSize = sampleRate / (magnitudes.length * 2);
  const lowBin = Math.max(0, Math.floor(freqLow / binSize));
  const highBin = Math.min(magnitudes.length - 1, Math.ceil(freqHigh / binSize));
  let energy = 0;
  for (let i = lowBin; i <= highBin; i++) {
    energy += magnitudes[i] * magnitudes[i];
  }
  return energy;
}
