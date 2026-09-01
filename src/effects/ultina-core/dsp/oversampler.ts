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
// Ultina — Shared 4x Oversampler
//
// Half-band FIR interpolation filter used by the Exciter and
// Clipper modules for aliasing-free waveshaping.
//
// 15-tap windowed-sinc with Hamming window, cutoff at π/4.
// ═══════════════════════════════════════════════════════════

export const OS_FACTOR = 4;

export const HB_TAPS = 15;

/**
 * Half-band FIR design values (raw table, sums to 0.998).
 * The exported HB_COEFS below normalizes them so the DC gain is
 * exactly 1: the raw table applied a systematic −0.017 dB droop per
 * stage (−0.035 dB through the exciter/clipper up→down path).
 */
const HB_COEFS_RAW = [
  -0.002580, -0.006670, -0.011390, 0.0,
  0.048180, 0.131630, 0.214830, 0.25,
  0.214830, 0.131630, 0.048180, 0.0,
  -0.011390, -0.006670, -0.002580,
];

/** Normalized half-band coefficients — DC gain exactly 1. */
export const HB_COEFS: Float32Array = (() => {
  const sum = HB_COEFS_RAW.reduce((a, b) => a + b, 0);
  return Float32Array.from(HB_COEFS_RAW, (v) => v / sum);
})();

/**
 * Total oversampler group delay in BASE-RATE samples.
 * Upsample FIR: (HB_TAPS-1)/2 = 7 OS samples; downsample FIR: another
 * 7; plus 2 OS samples of alignment delay in the downsampler so the
 * total (16 OS) divides evenly by OS_FACTOR → exactly 4 base samples.
 * Plugins report this for host delay compensation.
 */
export const OS_LATENCY_SAMPLES = (HB_TAPS - 1 + 2) / OS_FACTOR;

export interface OsChannelState {
  upHist: Float32Array;
  upHistWrite: number;
  downHist: Float32Array;
  downHistWrite: number;
  osBuffer: Float32Array;
  /** Downsampler alignment-delay state (2 OS samples). */
  dsD1: number;
  dsD2: number;
}

export function createOsChannelState(maxOsFrames: number): OsChannelState {
  return {
    upHist: new Float32Array(HB_TAPS),
    upHistWrite: 0,
    downHist: new Float32Array(HB_TAPS),
    downHistWrite: 0,
    osBuffer: new Float32Array(maxOsFrames),
    dsD1: 0,
    dsD2: 0,
  };
}

export function resetOsChannelState(s: OsChannelState): void {
  s.upHist.fill(0);
  s.upHistWrite = 0;
  s.downHist.fill(0);
  s.downHistWrite = 0;
  s.osBuffer.fill(0);
  s.dsD1 = 0;
  s.dsD2 = 0;
}

export function upsample(input: Float32Array, osState: OsChannelState, frames: number): void {
  const out = osState.osBuffer;
  const osFrames = frames * OS_FACTOR;
  const hist = osState.upHist;
  let hw = osState.upHistWrite;
  const tapLen = HB_TAPS;

  for (let i = 0; i < osFrames; i++) out[i] = 0;
  for (let i = 0; i < frames; i++) {
    out[i * OS_FACTOR] = input[i] * OS_FACTOR;
  }

  for (let i = 0; i < osFrames; i++) {
    hist[hw] = out[i];
    const nextHw = (hw + 1) % tapLen;

    let sum = 0;
    let histIdx = nextHw;
    for (let j = 0; j < tapLen; j++) {
      sum += hist[histIdx] * HB_COEFS[j];
      histIdx = (histIdx + 1) % tapLen;
    }

    out[i] = sum;
    hw = nextHw;
  }
  osState.upHistWrite = hw;
}

export function downsample(osState: OsChannelState, output: Float32Array, frames: number): void {
  const input = osState.osBuffer;
  const osFrames = frames * OS_FACTOR;
  const hist = osState.downHist;
  let hw = osState.downHistWrite;
  const tapLen = HB_TAPS;

  for (let i = 0; i < osFrames; i++) {
    hist[hw] = input[i];
    const nextHw = (hw + 1) % tapLen;

    // 2-OS-sample alignment delay (updated EVERY OS sample): up-FIR
    // (7 OS) + down-FIR (7 OS) + 2 OS = 16 OS = exactly 4 base
    // samples, matching the reported OS_LATENCY_SAMPLES.
    let sum = 0;
    let histIdx = (hw + 1) % tapLen;
    for (let j = 0; j < tapLen; j++) {
      sum += hist[histIdx] * HB_COEFS[j];
      histIdx = (histIdx + 1) % tapLen;
    }
    const delayed = osState.dsD2;
    osState.dsD2 = osState.dsD1;
    osState.dsD1 = sum;

    if (i % OS_FACTOR === 0) {
      output[i / OS_FACTOR] = delayed;
    }

    hw = nextHw;
  }
  osState.downHistWrite = hw;
}
