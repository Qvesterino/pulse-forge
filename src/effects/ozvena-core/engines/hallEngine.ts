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
// Ozvena — Hall / Large Chamber Engine (E3)
//
// 8-line FDN with Householder feedback matrix, per-line HF damping
// (IN the feedback loop), in-loop delay-line modulation (LFO per
// line with phase offsets), per-line input predelay offsets for
// height/depth, and progressive late-density buildup.
//
// Differentiated from Plate/Chamber:
//   • Longer base delay lengths (4.17 .. 24 s RT60)
//   • Wider L/R prime spread (~10%) for immersive stereo
//   • Per-line predelay offsets (height/depth illusion)
//   • Progressive density buildup (later lines shorter → denser tail)
//   • Warmer default damping (lower HF cutoff)
//   • Slower, deeper modulation for chorus-like hall shimmer
//
// Range: 4.17 .. 24 s RT60
// ═══════════════════════════════════════════════════════════

import type { HallEngineState, Engine3Algo } from "../v2/types.js";
import { clamp, flushDenormal, sanitize, TAU, hermiteInterp, nextPow2 } from "../dsp/math.js";
// Quantize libm-derived coefficients to float32: V8 and MSVC exp/pow/sin
// differ by ULPs, and inside a feedback loop a 1-ULP coefficient difference
// amplifies into full tail decorrelation. fround makes both ports identical.
const q32 = (x: number): number => Math.fround(x);
import {
  createBiquad,
  setLowPass,
  setHighPass,
  processBiquad,
  type BiquadState,
} from "../dsp/biquad.js";

export interface HallParams extends HallEngineState {}

const FDN_LINES = 8;

const BASE_LENGTHS_L = [2243, 2371, 2503, 2663, 2819, 2971, 3137, 3307];
const BASE_LENGTHS_R = [2053, 2179, 2311, 2459, 2617, 2789, 2969, 3163];

const LINE_PREDELAY_OFFSETS = [0, 5, 11, 18, 26, 35, 45, 56];

export interface HallEngine {
  prepare(sampleRate: number, channelCount: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: HallParams): void;
  setModulation(rateHz: number, depthSamples: number): void;
  /** Infinite tail hold: feedback gain → 1, loop input injection cut. */
  setFreeze(frozen: boolean): void;
  /**
   * Quality tier (0=eco, 1=standard, 2=high, 3=render) — scales the
   * shimmer grain window and drops to a single grain on eco. Scalar-only,
   * realtime-safe: the shimmer buffer is allocated for the largest tier.
   * Mirrors plateChamberEngine.ts exactly.
   */
  setQuality(tier: number): void;
  getLatencySamples(): number;
  reset(): void;
}

function householder8(v: Float64Array): void {
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += v[i];
  const mean = sum / 8;
  const offset = 2 * mean;
  for (let i = 0; i < 8; i++) v[i] = offset - v[i];
}

export function createHallEngine(): HallEngine {
  let sampleRate = 44100;
  let channelCount = 2;
  let params: HallParams = {
    enabled: true,
    space: 0.5,
    time: 6000,
    size: 0.5,
    diffusion: 70,
    attack: 50,
    crossoverHz: 800,
    balance: 0.5,
    dampingAmount: 5,
    dampingFreqHz: 4000,
    mix: 100,
    algo: "hall",
    bassDecay: 1.0,
    stereoWidth: 1.0,
    shimmer: 0,
  };

  let lines: Float32Array[][] = [];
  let writeIdx: number[][] = [];
  // Per-line `& mask` wrap constants (capacity is power of two) and the
  // per-line predelay offsets, hoisted out of the sample loop.
  const lineMaskC: Int32Array[] = [new Int32Array(FDN_LINES), new Int32Array(FDN_LINES)];
  const pdMaskC: Int32Array[] = [new Int32Array(FDN_LINES), new Int32Array(FDN_LINES)];
  const pdOffC: Int32Array[] = [new Int32Array(FDN_LINES), new Int32Array(FDN_LINES)];
  let lpState: number[][] = [];
  let hpState: number[][] = [];
  let hpPrev: number[][] = [];
  // Per-channel line lengths (read distances) — mirrors plate.
  const lengthsC: Float64Array[] = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  let feedbackGain = 0.5;
  let dampAlpha = 0.5;
  let attackAlpha = 1;
  // Feedback-loop DC-blocker pole — SR-independent. 30 Hz = DC/rumble
  // blocking only; the audible low-end shape is the bass-decay shelf.
  const FDN_HP_HZ = 30.0;
  let hpCoef = 0.97;
  let srScale = 1;

  // ── Input diffusor (Schroeder allpass ladder) — mirrors plate ──
  const DIFF_STAGES = 4;
  const DIFF_LENGTHS = [150, 211, 317, 422]; // samples @ 44.1 kHz
  let diffBufs: Float32Array[][] = [];
  let diffIdx: number[][] = [];
  let diffG = 0.5;

  // ── Bass decay shelf (in-loop) — mirrors plate ──
  const BASS_SHELF_HZ = 250.0;
  let bassAlpha = 0.02;
  let bassGain = 1.0;
  let bassLp: number[][] = [];

  // Per-sample per-channel scratch (interleaved channel processing).
  const tapsScratchC = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  const dampedScratchC = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  const pdScratchC = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  const wetSumC = [0.0, 0.0];
  const shiftedC = [0.0, 0.0];

  // ── Shimmer: dual-tap octave-up pitch shifter — mirrors plate ──
  // Quality tier scales the shimmer window (mirrors plateChamberEngine).
  const SH_WIN_BASE = 4096;
  const SH_WIN_MULT = [0.5, 1.0, 1.5, 2.0];
  let shWindow = 4096;
  let shWinMax = 8192;
  let shBuf: [Float32Array, Float32Array] = [new Float32Array(8192), new Float32Array(8192)];
  const shW = [0, 0];
  const shPhase = [0, 0];
  let shAmt = 0;
  let shQuality = 1;
  let shSingle = false;
  let freeze_ = false;

  let modRateHz = 0;
  let modDepthSamples = 0;
  let lfoPhase = 0;
  let lfoInc = 0;

  let predelayBufs: Float32Array[][] = [];
  let predelayIdx: number[][] = [];

  let lowSplitL: BiquadState = createBiquad(2);
  let highSplitL: BiquadState = createBiquad(2);
  let lowSplitR: BiquadState = createBiquad(2);
  let highSplitR: BiquadState = createBiquad(2);

  interface AlgoTuning { lenMult: number; dampHz: number; hpHz: number }

  const ALGO_TUNING: Record<Engine3Algo, AlgoTuning> = {
    largeChamber: { lenMult: 0.95, dampHz: 4500, hpHz: 150 },
    hall:         { lenMult: 1.0,  dampHz: 3500, hpHz: 130 },
  };

  function algoTuning(algo: Engine3Algo): AlgoTuning {
    return ALGO_TUNING[algo];
  }

  function recompute(): void {
    const t = algoTuning(params.algo);
    srScale = (sampleRate / 44100) * t.lenMult;
    const decaySec = clamp(params.time, 4170, 24000) / 1000;

    let avgLen = 0;
    for (let c = 0; c < 2; c++) {
      const base = (c & 1) ? BASE_LENGTHS_R : BASE_LENGTHS_L;
      for (let l = 0; l < FDN_LINES; l++) {
        const densityScale = 1 - l * 0.03;
        lengthsC[c][l] = Math.max(8, Math.round(base[l] * srScale * densityScale));
        avgLen += lengthsC[c][l];
      }
    }
    avgLen /= FDN_LINES * 2;

    const damp = (clamp(params.dampingAmount, 1, 11) - 1) / 10;
    const cutoffHz = clamp(params.dampingFreqHz, 30, 20000);
    dampAlpha = q32(clamp((1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)) * (0.3 + damp * 0.7), 1e-6, 1));
    hpCoef = q32(Math.exp((-TAU * FDN_HP_HZ) / sampleRate));

    // T60 calibration - mirrors plateChamberEngine.ts exactly: pure
    // per-pass target, NO scalar damping-loss compensation (a scalar
    // boost tilts the loop into a low-band hump that stretches the tail
    // far past the requested T60; see plateChamberEngine.ts).
    feedbackGain = clamp(
      q32(Math.pow(0.001, avgLen / (decaySec * sampleRate))),
      0, 0.99,
    );

    diffG = 0.3 + 0.45 * (clamp(params.diffusion, 0, 100) / 100);
    shAmt = clamp(params.shimmer, 0, 1);

    const bassMult = clamp(params.bassDecay, 0.25, 4);
    const fbBass = Math.pow(0.001, (avgLen / (decaySec * bassMult)) / sampleRate);
    bassGain = q32(clamp(fbBass / feedbackGain, 0.25, 2.5));
    bassAlpha = q32(1 - Math.exp((-TAU * BASS_SHELF_HZ) / sampleRate));

    attackAlpha = q32(1 - Math.exp(-1 / Math.max(0.001, (params.attack / 1000) * sampleRate)));

    setLowPass(lowSplitL.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);
    setHighPass(highSplitL.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);
    setLowPass(lowSplitR.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);
    setHighPass(highSplitR.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);

    lfoInc = (modRateHz * 0.7 * 2 * Math.PI) / sampleRate;

    // Buffers are sized for the largest supported tuning in prepare()
    // (hall, lenMult 1.0) — parameter changes are scalar-only.
  }

  function allocChannels(cc: number): void {
    // Allocate for the LARGEST supported tuning (hall, lenMult 1.0)
    // regardless of the current algorithm — algorithm/time changes stay
    // scalar-only. Extra slack does not change ring audio as long as the
    // buffer is longer than any read distance.
    const maxSrScale = sampleRate / 44100;
    lines = [];
    writeIdx = [];
    lpState = [];
    hpState = [];
    hpPrev = [];
    bassLp = [];
    diffBufs = [];
    diffIdx = [];
    predelayBufs = [];
    predelayIdx = [];
    for (let c = 0; c < cc; c++) {
      const db: Float32Array[] = [];
      const di: number[] = [];
      for (let s = 0; s < DIFF_STAGES; s++) {
        db.push(new Float32Array(Math.max(4, Math.round(DIFF_LENGTHS[s] * (sampleRate / 44100)))));
        di.push(0);
      }
      diffBufs.push(db);
      diffIdx.push(di);
    }
    const maxPredelay = Math.max(...LINE_PREDELAY_OFFSETS) + 4;
    for (let c = 0; c < cc; c++) {
      const base = (c & 1) ? BASE_LENGTHS_R : BASE_LENGTHS_L;
      const ls: Float32Array[] = [];
      const wi: number[] = [];
      const lp: number[] = [];
      const hp: number[] = [];
      const hpv: number[] = [];
      const blp: number[] = [];
      const pdBufs: Float32Array[] = [];
      const pdIdx: number[] = [];
      for (let l = 0; l < FDN_LINES; l++) {
        const densityScale = 1 - l * 0.03;
        // +32 headroom covers the maximum modulation read overshoot with
        // slack; power-of-two capacity lets the loop wrap with `& mask`
        // instead of `% len` (identical audio — all read distances stay
        // below the true ring length, so both wraps hit the same history).
        const maxLen = Math.max(8, Math.round(base[l] * maxSrScale * densityScale)) + 32;
        const cap = nextPow2(maxLen);
        ls.push(new Float32Array(cap));
        lineMaskC[c][l] = cap - 1;
        wi.push(0);
        lp.push(0);
        hp.push(0);
        hpv.push(0);
        blp.push(0);
        const pdLen = Math.max(4, Math.round(maxPredelay * maxSrScale));
        const pdCap = nextPow2(pdLen);
        pdBufs.push(new Float32Array(pdCap));
        pdMaskC[c][l] = pdCap - 1;
        pdOffC[c][l] = Math.min(LINE_PREDELAY_OFFSETS[l], pdLen - 1);
        pdIdx.push(0);
      }
      lines.push(ls);
      writeIdx.push(wi);
      lpState.push(lp);
      hpState.push(hp);
      hpPrev.push(hpv);
      bassLp.push(blp);
      predelayBufs.push(pdBufs);
      predelayIdx.push(pdIdx);
    }
  }

  function resetState(): void {
    for (const ls of lines) for (const b of ls) b.fill(0);
    for (const wis of writeIdx) for (let l = 0; l < wis.length; l++) wis[l] = 0;
    for (const lp of lpState) for (let l = 0; l < lp.length; l++) lp[l] = 0;
    for (const hp of hpState) for (let l = 0; l < hp.length; l++) hp[l] = 0;
    for (const hpv of hpPrev) for (let l = 0; l < hpv.length; l++) hpv[l] = 0;
    for (const bufs of predelayBufs) for (const b of bufs) b.fill(0);
    for (const idxs of predelayIdx) for (let l = 0; l < idxs.length; l++) idxs[l] = 0;
    for (const blp of bassLp) for (let l = 0; l < blp.length; l++) blp[l] = 0;
    for (const stages of diffBufs) for (const buf of stages) buf.fill(0);
    for (const idxs of diffIdx) for (let s = 0; s < idxs.length; s++) idxs[s] = 0;
    shBuf[0].fill(0); shBuf[1].fill(0);
    shW[0] = 0; shW[1] = 0;
    shPhase[0] = 0; shPhase[1] = 0;
    lfoPhase = 0;
  }

  let lowL: Float32Array = new Float32Array(0);
  let highL: Float32Array = new Float32Array(0);
  let lowR: Float32Array = new Float32Array(0);
  let highR: Float32Array = new Float32Array(0);
  // Per-block wet scratch (grow-only) — pure-wet engines never touch dry.
  let wetScratchL: Float32Array = new Float32Array(0);
  let wetScratchR: Float32Array = new Float32Array(0);

  function ensureScratch(n: number): void {
    if (lowL.length < n) {
      lowL = new Float32Array(n);
      highL = new Float32Array(n);
      lowR = new Float32Array(n);
      highR = new Float32Array(n);
    }
    if (wetScratchL.length < n) {
      wetScratchL = new Float32Array(n);
      wetScratchR = new Float32Array(n);
    }
  }

  let attackEnv = 0;

  // Input diffusor — mirrors plateChamberEngine.ts exactly.
  function processInputDiffusion(sample: number, c: number): number {
    const stages = diffBufs[c];
    const idxs = diffIdx[c];
    let x = sample;
    for (let s = 0; s < DIFF_STAGES; s++) {
      const buf = stages[s];
      const len = buf.length;
      const delayed = buf[idxs[s]];
      const out = delayed - diffG * x;
      buf[idxs[s]] = x + diffG * delayed;
      // Allpass delay time === buffer length, so the length must stay
      // exact (no pow2 rounding) — wrap with a branch instead of `%`.
      const next = idxs[s] + 1;
      idxs[s] = next >= len ? 0 : next;
      x = out;
    }
    return x;
  }

  // Scalar-only shimmer window sizing (no realloc — the ring is allocated
  // for the largest tier in prepare()). Mirrors plateChamberEngine.ts.
  function applyShimmerWindow(): void {
    shWindow = Math.max(
      2048,
      Math.round((SH_WIN_BASE * SH_WIN_MULT[shQuality] * sampleRate) / 48000) & ~1,
    );
    if (shWindow > shWinMax) shWindow = shWinMax;
  }

  return {
    prepare(sr, cc) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      allocChannels(channelCount);
      recompute();
      attackEnv = 0;
      lfoPhase = 0;
      // Allocate the shimmer ring for the LARGEST quality tier so
      // setQuality() stays a scalar-only realtime operation.
      shWinMax = Math.max(2048, Math.round((2 * SH_WIN_BASE * sampleRate) / 48000) & ~1);
      shBuf = [new Float32Array(2 * shWinMax), new Float32Array(2 * shWinMax)];
      applyShimmerWindow();
      shW[0] = 0; shW[1] = 0;
      shPhase[0] = 0; shPhase[1] = 0;
    },

    setQuality(tier) {
      const t = clamp(Math.round(tier), 0, 3);
      if (t === shQuality) return;
      shQuality = t;
      shSingle = t === 0;
      applyShimmerWindow();
    },

    setFreeze(frozen) {
      freeze_ = frozen;
    },

    // PURE-WET contract: the engine writes ONLY the reverb tail.
    process(channels, frameCount) {
      if (!params.enabled || frameCount <= 0) return;
      const cc = Math.min(channels.length, lines.length, 2);
      ensureScratch(frameCount);
      const wetL = cc > 0 ? wetScratchL : null;
      const wetR = cc > 1 ? wetScratchR : null;
      const lowMix = clamp(1 - params.balance, 0, 1) * 2;
      const highMix = clamp(params.balance, 0, 1) * 2;

      ensureScratch(frameCount);
      for (let c = 0; c < cc; c++) {
        const lowBuf = c === 0 ? lowL : lowR;
        const highBuf = c === 0 ? highL : highR;
        const inp = channels[c];
        for (let i = 0; i < frameCount; i++) {
          // Sanitize at the split entry: NaN/Inf would permanently
          // poison the biquad states and the FDN feedback loop.
          const v = inp[i];
          if (!Number.isFinite(v)) {
            lowBuf[i] = 0;
            highBuf[i] = 0;
          } else {
            lowBuf[i] = v;
            highBuf[i] = v;
          }
        }
        processBiquad(c === 0 ? lowSplitL : lowSplitR, [lowBuf], frameCount);
        processBiquad(c === 0 ? highSplitL : highSplitR, [highBuf], frameCount);
      }

      const fb = feedbackGain;
      const fbEff = freeze_ ? 1.0 : fb;
      const effectiveDepth = modDepthSamples;
      // Stereo width: cross-feed of the damped feedback between the L/R
      // loops. 1 = fully independent (widest), 0 = mono feedback.
      // Stereo width (Valhalla convention) — mirrors plateChamberEngine.
      const width = clamp(params.stereoWidth, 0, 1);

      for (let i = 0; i < frameCount; i++) {
        if (attackEnv < 1) {
          attackEnv += attackAlpha * (1 - attackEnv);
          if (attackEnv > 1) attackEnv = 1;
        }

        // ── Per channel: input → diffusor → per-line predelay → taps → damp ──
        for (let c = 0; c < cc; c++) {
          const ls = lines[c];
          const wis = writeIdx[c];
          const masks = lineMaskC[c];
          const pdMasks = pdMaskC[c];
          const pdOffs = pdOffC[c];
          const lp = lpState[c];
          const hp = hpState[c];
          const hpv = hpPrev[c];
          const pdBufs = predelayBufs[c];
          const pdIdx = predelayIdx[c];
          const taps = tapsScratchC[c];
          const pd = pdScratchC[c];
          const inpLow = c === 0 ? lowL : lowR;
          const inpHigh = c === 0 ? highL : highR;

          // Sanitize the input at the loop entry so NaN/Inf can never
          // ring inside the FDN delay lines. Freeze cuts the loop input
          // BEFORE the diffusor so the per-line predelay scratch and the
          // feedback write receive true silence (mirrors the native hall;
          // the old post-diffusor gate left the write path pd[l] live).
          let inSample = inpLow[i] * lowMix + inpHigh[i] * highMix;
          if (!Number.isFinite(inSample)) inSample = 0;
          if (freeze_) inSample = 0;
          inSample = processInputDiffusion(inSample, c);

          for (let l = 0; l < FDN_LINES; l++) {
            const pdBuf = pdBufs[l];
            pdBuf[pdIdx[l]] = inSample;
            pd[l] = pdBuf[(pdIdx[l] - pdOffs[l]) & pdMasks[l]];
            pdIdx[l] = (pdIdx[l] + 1) & pdMasks[l];

            const buf = ls[l];
            const m = masks[l];
            let readPos = wis[l] - lengthsC[c][l];
            if (effectiveDepth > 0) {
              const modPhase = lfoPhase + (l / FDN_LINES) * Math.PI * 2;
              readPos += Math.sin(modPhase) * effectiveDepth;
            }
            const riFloor = Math.floor(readPos);
            const ri0 = riFloor & m;
            const frac = readPos - riFloor;
            // 4-point Hermite — mirrors plateChamberEngine.ts exactly.
            if (frac > 0) {
              taps[l] = hermiteInterp(
                buf[(ri0 - 1) & m],
                buf[ri0],
                buf[(ri0 + 1) & m],
                buf[(ri0 + 2) & m],
                frac,
              );
            } else {
              taps[l] = buf[ri0];
            }
          }
          householder8(taps);

          for (let l = 0; l < FDN_LINES; l++) {
            lp[l] += dampAlpha * (taps[l] - lp[l]);
            lp[l] = flushDenormal(lp[l]);
            const dampedV = sanitize(lp[l]);
            hp[l] = hpCoef * (hp[l] + dampedV - hpv[l]);
            hp[l] = flushDenormal(hp[l]);
            hpv[l] = dampedV;
            dampedScratchC[c][l] = dampedV;
          }
          let wet = 0;
          for (let l = 0; l < FDN_LINES; l++) wet += hp[l];
          wetSumC[c] = wet;

          // Shimmer: push the loop sum, read the octave-up grain.
          if (shAmt > 0) {
            let dsum = 0;
            for (let l = 0; l < FDN_LINES; l++) dsum += dampedScratchC[c][l];
            dsum /= FDN_LINES;
            const buf = shBuf[c];
            buf[shW[c]] = dsum;
            shW[c] = (shW[c] + 1) % buf.length;
            const size = buf.length;
            const W = shWindow;
            shPhase[c] += 1;
            if (shPhase[c] >= W) shPhase[c] -= W;
            const ph = shPhase[c];
            const d0 = W - ph;
            const i0 = ((shW[c] - d0) % size + size) % size;
            const ph1 = (ph + W / 2) % W;
            const d1 = W - ph1;
            const i1 = ((shW[c] - d1) % size + size) % size;
            const g0 = q32(Math.sin((Math.PI * ph) / W));
            if (shSingle) {
              // Eco tier: one grain (half the shimmer cost). A lone sin-π
              // window has half the dual-tap power (g0²+g1² = 1), so the
              // surviving tap gains √2 to keep the injected level equal.
              shiftedC[c] = 1.4142 * g0 * buf[i0];
            } else {
              const g1 = q32(Math.sin((Math.PI * ph1) / W));
              shiftedC[c] = g0 * buf[i0] + g1 * buf[i1];
            }
          } else {
            shiftedC[c] = 0;
          }
        }

        // ── Feedback writes with stereo-width cross-feed + bass shelf ──
        for (let c = 0; c < cc; c++) {
          const ls = lines[c];
          const wis = writeIdx[c];
          const masks = lineMaskC[c];
          const blp = bassLp[c];
          const damped = dampedScratchC[c];
          const dampedO = dampedScratchC[cc > 1 ? 1 - c : c];
          const pd = pdScratchC[c];
          for (let l = 0; l < FDN_LINES; l++) {
            const direct = width * damped[l] + (1 - width) * 0.5 * (damped[l] + dampedO[l]);
            // Shimmer INJECTS the octave-up grain as extra loop input —
            // the direct feedback stays intact so loop gain never exceeds
            // fb (stable), and the pitched content re-enters the shifter
            // on later passes (the classic cascading shimmer buildup).
            const eff = direct + shAmt * shiftedC[c] * 0.5;
            blp[l] += bassAlpha * (eff - blp[l]);
            blp[l] = flushDenormal(blp[l]);
            const shelved = eff + (bassGain - 1) * sanitize(blp[l]);
            ls[l][wis[l]] = pd[l] + shelved * fbEff;
            wis[l] = (wis[l] + 1) & masks[l];
          }
          const out = c === 0 ? wetL : wetR;
          if (out) out[i] = (wetSumC[c] / FDN_LINES) * attackEnv;
        }

        lfoPhase += lfoInc;
        if (lfoPhase >= Math.PI * 2) lfoPhase -= Math.PI * 2;
      }

      // Pure wet write-back — no dry, no mix gain. The width knob is
      // completed with an output-side M/S blend: in-loop crossfeed alone
      // cannot reach true mono (each channel renders the shared field
      // through its own decorrelated line lengths), so 0 blends both
      // outputs to the identical mono sum, 1 leaves the stereo untouched.
      if (cc > 1) {
        const w = width;
        const inv = 1 - w;
        for (let i = 0; i < frameCount; i++) {
          const mono = (wetL![i] + wetR![i]) * 0.5;
          channels[0][i] = wetL![i] * w + mono * inv;
          channels[1][i] = wetR![i] * w + mono * inv;
        }
      } else {
        for (let i = 0; i < frameCount; i++) {
          channels[0][i] = wetL![i];
        }
      }
    },

    setParams(p) {
      params = { ...p };
      recompute();
      attackEnv = 0;
    },

    setModulation(rateHz: number, depthSamples: number) {
      modRateHz = clamp(rateHz, 0, 20);
      modDepthSamples = clamp(depthSamples, 0, 20);
      lfoInc = (modRateHz * 0.7 * 2 * Math.PI) / sampleRate;
    },

    getLatencySamples() {
      return 0;
    },

    reset() {
      resetState();
      attackEnv = 0;
      lowSplitL.z1.fill(0); lowSplitL.z2.fill(0);
      highSplitL.z1.fill(0); highSplitL.z2.fill(0);
      lowSplitR.z1.fill(0); lowSplitR.z2.fill(0);
      highSplitR.z1.fill(0); highSplitR.z2.fill(0);
    },
  };
}
