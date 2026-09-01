/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Realtime spectrum analyzer
//
// Two-side design:
//   • Audio side:  push(tap, channels, frameCount) — appends to a ring
//                   buffer. Cheap; no FFT work.
//   • UI / analyzer side:  snapshot(tap, outDb) — reads the latest
//                   fftSize samples, runs a Hann-windowed FFT, returns
//                   a dB magnitude vector on a caller-provided grid.
//
// Used for:
//   • Realtime spectrum overlay in the editor
//   • Auto Cut (Pre EQ) analyzer
//   • Unmask (Reverb EQ) analyzer
//   • Masking Meter (dry vs wet diff)
//
// Threading: ring buffer + scratch are reused. No allocation in
// steady state.
// ═══════════════════════════════════════════════════════════

import { hannWindow, magnitudeSpectrum } from "./fft.js";

export type AnalyzerTap = "input" | "dry" | "wet" | "output";

export const FFT_SIZES = [512, 1024, 2048, 4096] as const;
export type FftSize = (typeof FFT_SIZES)[number];

export interface SpectrumAnalyzer {
  readonly fftSize: number;
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  setFftSize(size: FftSize): void;
  push(tap: AnalyzerTap, channels: Float32Array[], frameCount: number): void;
  /**
   * Compute the dB magnitude spectrum for the latest fftSize samples
   * on a caller-provided frequency grid. `outDb` must have length
   * ≥ gridFreqs.length. Returns the number of bins written.
   */
  snapshot(
    tap: AnalyzerTap,
    outDb: Float32Array,
    gridFreqs: ArrayLike<number>,
    sampleRate: number,
    dbFloor?: number,
  ): number;
  reset(): void;
}

const TAPS: readonly AnalyzerTap[] = ["input", "dry", "wet", "output"];

export function createSpectrumAnalyzer(opts: { fftSize?: FftSize; downmix?: "mono" | "max" } = {}): SpectrumAnalyzer {
  let fftSize: number = opts.fftSize ?? 2048;
  const downmix: "mono" | "max" = opts.downmix ?? "mono";
  let enabled = true;

  const rings: Record<AnalyzerTap, Float32Array> = {
    input: new Float32Array(fftSize),
    dry: new Float32Array(fftSize),
    wet: new Float32Array(fftSize),
    output: new Float32Array(fftSize),
  };
  const writePos: Record<AnalyzerTap, number> = {
    input: 0, dry: 0, wet: 0, output: 0,
  };

  let window = hannWindow(fftSize);
  let fftInput = new Float32Array(fftSize);
  let scratchRe = new Float64Array(fftSize);
  let scratchIm = new Float64Array(fftSize);
  let magBuf = new Float32Array(fftSize / 2 + 1);

  function allocBuffers(size: number): void {
    for (const t of TAPS) {
      rings[t] = new Float32Array(size);
      writePos[t] = 0;
    }
    window = hannWindow(size);
    fftInput = new Float32Array(size);
    scratchRe = new Float64Array(size);
    scratchIm = new Float64Array(size);
    magBuf = new Float32Array(size / 2 + 1);
  }

  return {
    get fftSize() { return fftSize; },
    get enabled() { return enabled; },

    setEnabled(on) { enabled = on; },

    setFftSize(size) {
      fftSize = size;
      allocBuffers(size);
    },

    push(tap, channels, frameCount) {
      if (!enabled || frameCount <= 0) return;
      const ring = rings[tap];
      const N = ring.length;
      const cc = channels.length;
      let pos = writePos[tap];

      for (let i = 0; i < frameCount; i++) {
        let s = 0;
        if (downmix === "max") {
          let m = 0;
          for (let c = 0; c < cc; c++) {
            const a = Math.abs(channels[c][i]);
            if (a > m) m = a;
          }
          for (let c = 0; c < cc; c++) {
            if (Math.abs(channels[c][i]) >= m * 0.999) {
              s = channels[c][i];
              break;
            }
          }
        } else {
          for (let c = 0; c < cc; c++) s += channels[c][i];
          s /= cc;
        }
        ring[pos] = s;
        pos++;
        if (pos >= N) pos = 0;
      }
      writePos[tap] = pos;
    },

    snapshot(tap, outDb, gridFreqs, sampleRate, dbFloor = -120) {
      const n = gridFreqs.length;
      if (outDb.length < n) {
        throw new Error("snapshot: outDb too small for gridFreqs");
      }
      if (!enabled) {
        for (let i = 0; i < n; i++) outDb[i] = dbFloor;
        return n;
      }
      const ring = rings[tap];
      const N = fftSize;
      const half = N >> 1;
      const pos = writePos[tap];
      for (let k = 0; k < N; k++) fftInput[k] = ring[(pos + k) % N];
      magnitudeSpectrum(fftInput, window, magBuf, scratchRe, scratchIm);

      for (let g = 0; g < n; g++) {
        const f = gridFreqs[g];
        const fLo = g > 0 ? Math.sqrt(gridFreqs[g - 1] * f) : f * 0.85;
        const fHi = g < n - 1 ? Math.sqrt(gridFreqs[g + 1] * f) : f * 1.15;
        const kLo = Math.max(0, Math.floor((fLo * N) / sampleRate));
        const kHi = Math.min(half, Math.ceil((fHi * N) / sampleRate));
        let maxMag = 0;
        for (let k = kLo; k < kHi; k++) {
          if (magBuf[k] > maxMag) maxMag = magBuf[k];
        }
        let db = maxMag > 0 ? 20 * Math.log10(maxMag) : dbFloor;
        if (db < dbFloor) db = dbFloor;
        outDb[g] = db;
      }
      return n;
    },

    reset() {
      for (const t of TAPS) {
        rings[t].fill(0);
        writePos[t] = 0;
      }
    },
  };
}

/**
 * Default log-frequency grid for spectrum display and analyzers.
 * 120 points spanning 20 Hz → 20 kHz on a log scale.
 */
export function defaultSpectrumGrid(binsPerDecade = 12): Float32Array {
  const out: number[] = [];
  const fMin = 20;
  const fMax = 20000;
  const decades = Math.log10(fMax / fMin);
  const count = Math.ceil(decades * binsPerDecade);
  for (let i = 0; i < count; i++) {
    const exp = i / binsPerDecade;
    out.push(fMin * Math.pow(10, exp));
  }
  return new Float32Array(out);
}
