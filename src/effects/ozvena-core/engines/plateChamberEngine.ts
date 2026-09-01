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
// Ozvena — Plate / Room / Medium Chamber Engine (E2)
//
// 8-line FDN with Householder feedback matrix, per-line HF damping
// (IN the feedback loop), in-loop delay-line modulation (LFO per
// line with phase offsets for chorus/detune), and a per-band
// low/high split (crossover + balance).
//
// Plate algorithm adds a 4-stage allpass ladder before the FDN
// for EMT 140-style dense, bright, metallic diffusion.
//
// Algorithm select:
//   • room          — neutral, broad-band RT60, no allpass
//   • mediumChamber — longer initial reflections, warmer HF, no allpass
//   • plate         — allpass ladder + dense FDN + fast mod
//
// Range: 1.4 .. 14 s RT60
// ═══════════════════════════════════════════════════════════

import type { PlateChamberEngineState, Engine2Algo } from "../v2/types.js";
import { clamp, flushDenormal, sanitize, TAU, hermiteInterp } from "../dsp/math.js";
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

export interface PlateChamberParams extends PlateChamberEngineState {}

const FDN_LINES = 8;

const BASE_LENGTHS_L = [1087, 1153, 1249, 1327, 1409, 1493, 1583, 1687];
const BASE_LENGTHS_R = [1051, 1117, 1201, 1291, 1373, 1459, 1543, 1637];

const ALLPASS_STAGES = 4;
const ALLPASS_LENGTHS = [142, 237, 391, 523];
const ALLPASS_GAINS = [0.5, 0.45, 0.4, 0.35];

export interface PlateChamberEngine {
  prepare(sampleRate: number, channelCount: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: PlateChamberParams): void;
  setModulation(rateHz: number, depthSamples: number): void;
  /** Infinite tail hold: feedback gain → 1, loop input injection cut. */
  setFreeze(frozen: boolean): void;
  /**
   * Quality tier (0=eco, 1=standard, 2=high, 3=render) — scales the
   * shimmer grain window and drops to a single grain on eco. Scalar-only,
   * realtime-safe: the shimmer buffer is allocated for the largest tier.
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

export function createPlateChamberEngine(): PlateChamberEngine {
  let sampleRate = 44100;
  let channelCount = 2;
  let params: PlateChamberParams = {
    enabled: true,
    space: 0.5,
    time: 2000,
    size: 0.5,
    diffusion: 70,
    attack: 30,
    crossoverHz: 1000,
    balance: 0.5,
    dampingAmount: 5,
    dampingFreqHz: 5000,
    mix: 100,
    algo: "room",
    bassDecay: 1.0,
    stereoWidth: 1.0,
    shimmer: 0,
  };

  let lines: Float32Array[][] = [];
  let writeIdx: number[][] = [];
  let lpState: number[][] = [];
  let hpState: number[][] = [];
  let hpPrev: number[][] = [];
  // Per-channel line lengths (read distances) — L/R use their own base
  // tables so the channels are genuinely decorrelated. Written by
  // recompute(), read by process().
  const lengthsC: Float64Array[] = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  let feedbackGain = 0.5;
  let dampAlpha = 0.5;
  let attackAlpha = 1;
  // Feedback-loop DC-blocker pole — SR-independent. 30 Hz = DC/rumble
  // blocking only; the audible low-end shape is the bass-decay shelf below.
  const FDN_HP_HZ = 30.0;
  let hpCoef = 0.97;
  let srScale = 1;

  // ── Input diffusor (Schroeder allpass ladder, all algos) ──
  // Smears the input transients before the FDN so the input pattern does
  // not stay audible in the tail. `diffusion` (0..100) maps to the
  // allpass coefficient 0.3..0.75.
  const DIFF_STAGES = 4;
  const DIFF_LENGTHS = [150, 211, 317, 422]; // samples @ 44.1 kHz
  let diffBufs: Float32Array[][] = [];
  let diffIdx: number[][] = [];
  let diffG = 0.5;

  // ── Bass decay shelf (in-loop) ────────────────────────────
  // One-pole shelf: y = x + (bassGain-1)*LP(x). At DC the loop gain
  // becomes fb*bassGain → bass rings longer (multiplier > 1) or shorter.
  const BASS_SHELF_HZ = 250.0;
  let bassAlpha = 0.02;
  let bassGain = 1.0;
  let bassLp: number[][] = [];

  // Per-sample per-channel scratch (interleaved channel processing).
  const tapsScratchC = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  const dampedScratchC = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  const inScratchC = [0.0, 0.0];
  const wetSumC = [0.0, 0.0];
  const shiftedC = [0.0, 0.0];

  // ── Shimmer: dual-tap octave-up pitch shifter on the loop signal ──
  // Two Hann(sin-π) crossfaded read taps scan the ring at 2× speed →
  // +12 semitones, constant power (g0²+g1² = 1). The quality tier scales
  // the window (render = 2×, longest/smoother grain) and eco drops to a
  // single tap (half the per-sample shimmer cost). The buffer is always
  // allocated for the largest tier, so tier changes are scalar-only.
  const SH_WIN_BASE = 4096; // window @ 48 kHz, standard tier
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

  let apLines: Float32Array[][] = [];
  let apIdx: number[][] = [];

  let lowSplitL: BiquadState = createBiquad(2);
  let highSplitL: BiquadState = createBiquad(2);
  let lowSplitR: BiquadState = createBiquad(2);
  let highSplitR: BiquadState = createBiquad(2);

  interface AlgoTuning { lenMult: number; dampHz: number; hpHz: number; modRateMult: number; modDepthMult: number }

  // Constant table — algoTuning() must not allocate an object per call
  // (it is read from the realtime process loop).
  const ALGO_TUNING: Record<Engine2Algo, AlgoTuning> = {
    room:          { lenMult: 1.0,  dampHz: 5000, hpHz: 180, modRateMult: 1.0, modDepthMult: 0.5 },
    mediumChamber: { lenMult: 1.15, dampHz: 4500, hpHz: 160, modRateMult: 0.8, modDepthMult: 0.7 },
    plate:         { lenMult: 0.70, dampHz: 8000, hpHz: 300, modRateMult: 1.5, modDepthMult: 1.0 },
  };

  function algoTuning(algo: Engine2Algo): AlgoTuning {
    return ALGO_TUNING[algo];
  }

  function recompute(): void {
    const t = algoTuning(params.algo);
    srScale = (sampleRate / 44100) * t.lenMult;
    const decaySec = clamp(params.time, 1400, 14000) / 1000;

    let avgLen = 0;
    for (let c = 0; c < 2; c++) {
      const base = (c & 1) ? BASE_LENGTHS_R : BASE_LENGTHS_L;
      for (let l = 0; l < FDN_LINES; l++) {
        lengthsC[c][l] = Math.max(8, Math.round(base[l] * srScale));
        avgLen += lengthsC[c][l];
      }
    }
    avgLen /= FDN_LINES * 2;

    const damp = (clamp(params.dampingAmount, 1, 11) - 1) / 10;
    const cutoffHz = clamp(params.dampingFreqHz, 30, 20000);
    dampAlpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
    dampAlpha = q32(clamp(dampAlpha * (0.3 + damp * 0.7), 1e-6, 1));
    hpCoef = q32(Math.exp((-TAU * FDN_HP_HZ) / sampleRate));

    // T60 CALIBRATION: fb is the PURE per-pass target — after one pass of
    // `avgLen` samples the amplitude has dropped exactly toward the
    // requested RT60. The damping LPF's midband loss is deliberately NOT
    // divided out: a scalar compensation tilts the loop (over-boosting the
    // loss-free low band), which stacks with the bass shelf into a
    // 200–800 Hz loop-gain hump and stretches the tail far past the
    // requested T60 (measured 3.3 s for a 2.0 s request). With the pure
    // target the loop gain stays monotonically ≤ target everywhere and
    // the damping interaction keeps the broadband decay within ~+18% at
    // default damping. The damper remains in-loop HF decay shaping.
    feedbackGain = clamp(
      q32(Math.pow(0.001, avgLen / (decaySec * sampleRate))),
      0, 0.99,
    );

    // Input diffusion amount (wires the previously unused `diffusion`).
    diffG = 0.3 + 0.45 * (clamp(params.diffusion, 0, 100) / 100);
    shAmt = clamp(params.shimmer, 0, 1);

    // Bass decay: bass loop gain = fb * bassGain must equal the loop gain
    // of a reverb with T60 * bassDecay, i.e.
    //   bassGain = 0.001^(avgLen/sr * (1/T60 - 1/(T60*bassDecay)))
    const bassMult = clamp(params.bassDecay, 0.25, 4);
    const fbBass = Math.pow(0.001, (avgLen / (decaySec * bassMult)) / sampleRate);
    bassGain = q32(clamp(fbBass / feedbackGain, 0.25, 2.5));
    bassAlpha = q32(1 - Math.exp((-TAU * BASS_SHELF_HZ) / sampleRate));

    attackAlpha = q32(1 - Math.exp(-1 / Math.max(0.001, (params.attack / 1000) * sampleRate)));

    setLowPass(lowSplitL.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);
    setHighPass(highSplitL.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);
    setLowPass(lowSplitR.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);
    setHighPass(highSplitR.coeffs, clamp(params.crossoverHz, 20, 4000), 0.7071, sampleRate);

    lfoInc = (modRateHz * t.modRateMult * 2 * Math.PI) / sampleRate;

    // Buffers are sized for the largest supported tuning in prepare()
    // (mediumChamber, lenMult 1.15) — a parameter or algorithm change is a
    // scalar-only realtime operation and must never reallocate.
  }

  function allocChannels(cc: number): void {
    // Allocate for the LARGEST supported FDN tuning (mediumChamber,
    // lenMult 1.15) and for the plate allpass ladder regardless of the
    // current algorithm — makes algorithm/time changes scalar-only.
    // Ring semantics are unaffected by extra slack as long as the buffer
    // is longer than any read distance (baseLen + max modulation offset).
    const maxSrScale = (sampleRate / 44100) * 1.15;
    lines = [];
    writeIdx = [];
    lpState = [];
    hpState = [];
    hpPrev = [];
    bassLp = [];
    diffBufs = [];
    diffIdx = [];
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
    for (let c = 0; c < cc; c++) {
      const base = (c & 1) ? BASE_LENGTHS_R : BASE_LENGTHS_L;
      const ls: Float32Array[] = [];
      const wi: number[] = [];
      const lp: number[] = [];
      const hp: number[] = [];
      const hpv: number[] = [];
      const blp: number[] = [];
      for (let l = 0; l < FDN_LINES; l++) {
        const maxLen = Math.max(8, Math.round(base[l] * maxSrScale)) + 16;
        ls.push(new Float32Array(maxLen));
        wi.push(0);
        lp.push(0);
        hp.push(0);
        hpv.push(0);
        blp.push(0);
      }
      lines.push(ls);
      writeIdx.push(wi);
      bassLp.push(blp);
      lpState.push(lp);
      hpState.push(hp);
      hpPrev.push(hpv);
    }

    // The allpass ladder is always allocated (zero delay length depends on
    // the exact buffer size, so it uses the same fixed formula as the
    // native engine: no algorithm lenMult).
    apLines = [];
    apIdx = [];
    for (let c = 0; c < cc; c++) {
      const stageLines: Float32Array[] = [];
      const stageIdx: number[] = [];
      for (let s = 0; s < ALLPASS_STAGES; s++) {
        stageLines.push(new Float32Array(Math.max(4, Math.round(ALLPASS_LENGTHS[s] * (sampleRate / 44100)))));
        stageIdx.push(0);
      }
      apLines.push(stageLines);
      apIdx.push(stageIdx);
    }
  }

  function resetState(): void {
    for (const ls of lines) for (const b of ls) b.fill(0);
    for (const wis of writeIdx) for (let l = 0; l < wis.length; l++) wis[l] = 0;
    for (const lp of lpState) for (let l = 0; l < lp.length; l++) lp[l] = 0;
    for (const hp of hpState) for (let l = 0; l < hp.length; l++) hp[l] = 0;
    for (const hpv of hpPrev) for (let l = 0; l < hpv.length; l++) hpv[l] = 0;
    for (const blp of bassLp) for (let l = 0; l < blp.length; l++) blp[l] = 0;
    for (const stages of apLines) for (const buf of stages) buf.fill(0);
    for (const idxs of apIdx) for (let s = 0; s < idxs.length; s++) idxs[s] = 0;
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

  function processAllpass(sample: number, c: number): number {
    if (params.algo !== "plate") return sample;
    const stages = apLines[c];
    const idxs = apIdx[c];
    let x = sample;
    for (let s = 0; s < ALLPASS_STAGES; s++) {
      const buf = stages[s];
      const len = buf.length;
      const delayed = buf[idxs[s]];
      const g = ALLPASS_GAINS[s];
      const out = delayed - g * x;
      buf[idxs[s]] = x + g * delayed;
      idxs[s] = (idxs[s] + 1) % len;
      x = out;
    }
    return x;
  }

  // Input diffusor — 4-stage Schroeder allpass ladder applied to every
  // algorithm, coefficient driven by `diffusion`. Kills the audible
  // "input pattern echo" inside the tail.
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
      idxs[s] = (idxs[s] + 1) % len;
      x = out;
    }
    return x;
  }

  // Scalar-only shimmer window sizing (no realloc — the ring is allocated
  // for the largest tier in prepare()). Phase/write indices keep cycling
  // over the full buffer; grain reads only reach shWindow back.
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

    // PURE-WET contract: the engine writes ONLY the reverb tail into the
    // channel buffers — the processor owns every dry/wet/blend gain. This
    // removes the lossy wet-recovery division from the processor.
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
      const t = algoTuning(params.algo);
      const effectiveDepth = modDepthSamples * t.modDepthMult;
      // Stereo width (Valhalla convention): 1 = fully independent L/R
      // loops (widest), 0 = both loops write the identical mono sum
      // (true mono — correlated). In between: a linear blend. The old
      // formula cross-fed the OTHER channel directly, which at 0 made a
      // swap, not mono — the decorrelated per-channel line lengths kept
      // the output wide.
      const width = clamp(params.stereoWidth, 0, 1);

      for (let i = 0; i < frameCount; i++) {
        if (attackEnv < 1) {
          attackEnv += attackAlpha * (1 - attackEnv);
          if (attackEnv > 1) attackEnv = 1;
        }

        // ── Per channel: input → diffusor → ladder → taps → matrix → damp ──
        for (let c = 0; c < cc; c++) {
          const ls = lines[c];
          const wis = writeIdx[c];
          const lp = lpState[c];
          const hp = hpState[c];
          const hpv = hpPrev[c];
          const taps = tapsScratchC[c];
          const inpLow = c === 0 ? lowL : lowR;
          const inpHigh = c === 0 ? highL : highR;

          // Sanitize the feedback input at the loop entry so NaN/Inf
          // can never ring inside the FDN delay lines. Freeze cuts the
          // loop input injection entirely.
          let inSample = inpLow[i] * lowMix + inpHigh[i] * highMix;
          if (!Number.isFinite(inSample)) inSample = 0;
          inSample = processInputDiffusion(inSample, c);
          inSample = processAllpass(inSample, c);
          inScratchC[c] = freeze_ ? 0 : inSample;

          for (let l = 0; l < FDN_LINES; l++) {
            const baseLen = lengthsC[c][l];
            let readPos: number;
            if (effectiveDepth > 0) {
              const modPhase = lfoPhase + (l / FDN_LINES) * Math.PI * 2;
              const modOffset = Math.sin(modPhase) * effectiveDepth;
              readPos = wis[l] - baseLen + modOffset;
            } else {
              readPos = wis[l] - baseLen;
            }
            const bufLen = ls[l].length;
            readPos = ((readPos % bufLen) + bufLen) % bufLen;
            const ri0 = Math.floor(readPos);
            const ri1 = (ri0 + 1) % bufLen;
            const frac = readPos - ri0;
            // 4-point Hermite — aliasing-free modulated reads (with no
            // modulation frac === 0 and this reduces exactly to ri0).
            if (frac > 0) {
              const rim1 = (ri0 + bufLen - 1) % bufLen;
              const ri2 = (ri0 + 2) % bufLen;
              taps[l] = hermiteInterp(ls[l][rim1], ls[l][ri0], ls[l][ri1], ls[l][ri2], frac);
            } else {
              taps[l] = ls[l][ri0];
            }
          }
          householder8(taps);

          let wet = 0;
          const damped = dampedScratchC[c];
          for (let l = 0; l < FDN_LINES; l++) {
            lp[l] += dampAlpha * (taps[l] - lp[l]);
            lp[l] = flushDenormal(lp[l]);
            const dampedV = sanitize(lp[l]);
            hp[l] = hpCoef * (hp[l] + dampedV - hpv[l]);
            hp[l] = flushDenormal(hp[l]);
            hpv[l] = dampedV;
            wet += hp[l];
            damped[l] = dampedV;
          }
          wetSumC[c] = wet;

          // Shimmer: push the loop sum, read the octave-up grain.
          if (shAmt > 0) {
            let dsum = 0;
            for (let l = 0; l < FDN_LINES; l++) dsum += damped[l];
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
            const g0 = q32(Math.sin((Math.PI * ph) / W));
            if (shSingle) {
              // Eco tier: one grain (half the shimmer cost). A lone sin-π
              // window has half the dual-tap power (g0²+g1² = 1), so the
              // surviving tap gains √2 to keep the injected level equal.
              shiftedC[c] = 1.4142 * g0 * buf[i0];
            } else {
              const ph1 = (ph + W / 2) % W;
              const d1 = W - ph1;
              const i1 = ((shW[c] - d1) % size + size) % size;
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
          const blp = bassLp[c];
          const damped = dampedScratchC[c];
          const dampedO = dampedScratchC[cc > 1 ? 1 - c : c];
          const inSample = inScratchC[c];
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
            ls[l][wis[l]] = inSample + shelved * fbEff;
            wis[l] = (wis[l] + 1) % ls[l].length;
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
      // Algorithm switches are scalar-only: all buffers (FDN lines and the
      // allpass ladder) are allocated for the largest tuning in prepare().
      params = { ...p };
      recompute();
      attackEnv = 0;
    },

    setModulation(rateHz: number, depthSamples: number) {
      modRateHz = clamp(rateHz, 0, 20);
      modDepthSamples = clamp(depthSamples, 0, 16);
      const t = algoTuning(params.algo);
      lfoInc = (modRateHz * t.modRateMult * 2 * Math.PI) / sampleRate;
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
