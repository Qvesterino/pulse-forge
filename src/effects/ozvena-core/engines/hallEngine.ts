/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: zero-channel guard + NaN attackEnv heal in recompute.)
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
import { clamp, flushDenormal, sanitize, TAU, hermiteInterp } from "../dsp/math.js";
// Quantize libm-derived coefficients to float32: V8 and MSVC exp/pow/sin
// differ by ULPs, and inside a feedback loop a 1-ULP coefficient difference
// amplifies into full tail decorrelation. fround makes both ports identical.
const q32 = (x: number): number => Math.fround(x);
import { createBiquad, setLowPass, setHighPass, processBiquad, type BiquadState } from "../dsp/biquad.js";

export interface HallParams extends HallEngineState {}

const FDN_LINES = 16;
// Broadband level compensation for the O2 density upgrade: with N
// decorrelated lines the averaged output amplitude scales ~1/√N vs the
// historical 8-line reference, so gain back √(N/8).
const DENSITY_GAIN = Math.sqrt(FDN_LINES / 8);

const BASE_LENGTHS_L = [2243, 2371, 2503, 2663, 2819, 2971, 3137, 3307, 3449, 3607, 3767, 3947, 4127, 4283, 4451, 4639];
const BASE_LENGTHS_R = [2053, 2179, 2311, 2459, 2617, 2789, 2969, 3163, 3319, 3467, 3613, 3779, 3917, 4057, 4201, 4363];

const LINE_PREDELAY_OFFSETS = [0, 5, 11, 18, 26, 35, 45, 56, 68, 81, 95, 110, 126, 143, 161, 180];

export interface HallEngine {
  prepare(sampleRate: number, channelCount: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: HallParams): void;
  setModulation(rateHz: number, depthSamples: number, maxDepth?: number): void;
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

// Householder reflection about the all-ones axis — norm-preserving for
// ANY line count (roadmap O2: 12/16 lines for density without level loss).
function householderN(v: Float64Array): void {
  let sum = 0;
  for (let i = 0; i < FDN_LINES; i++) sum += v[i];
  const mean = sum / FDN_LINES;
  const offset = 2 * mean;
  for (let i = 0; i < FDN_LINES; i++) v[i] = offset - v[i];
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
    midDecay: 1.0,
    bassDecay: 1.0,
    modRateMult: 1.0,
    stereoWidth: 1.0,
    shimmer: 0,
    drive: 0,
  };

  let lines: Float32Array[][] = [];
  let writeIdx: number[][] = [];
  let lpState: number[][] = [];
  let hpState: number[][] = [];
  let hpPrev: number[][] = [];
  // Per-channel line lengths (read distances) — mirrors plate.
  const lengthsC: Float64Array[] = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  // Length-change crossfade (same mechanism as preDelay's 20 ms crossfade):
  // time/size/algo automation changes the FDN read distances; blending the
  // old and new taps over ~20 ms turns the jump into an inaudible morph.
  const oldLengthsC: Float64Array[] = [new Float64Array(FDN_LINES), new Float64Array(FDN_LINES)];
  let lensFadeRemaining = 0;
  let lensFadeLen = 1;
  let hasRendered = false;
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
  // O3: mid/high crossover and per-band calibration reference frequencies.
  const MID_XOVER_HZ = 3500.0;
  const MID_REF_HZ = 300.0;
  // Calibrated compensation exponent (roadmap O4): 1.0 = full loss at the
  // band lower edge — the late EDC of a band-split measurement is dominated
  // by the slowest-decaying (lowest-loss) frequency in the band, so the
  // edge loss, not the band-center loss, is what the measured T60 sees.
  const O4_BETA = 1.0;

  let bassAlpha = 0.02;
  let bassGain = 1.0;
  let midBandGain = 1.0;
  let bassLp: number[][] = [];
  // O3 multiband decay network: second one-pole state for the mid/high
  // split (low + mid + high reconstruct the loop input sample-exactly).
  let midLp: number[][] = [];
  let midAlpha = 0.02;

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
  // Shimmer loop-stability guard scalars (see recompute): injection gain
  // and the direct-feedback weight that keeps the per-pass loop gain < 1.
  // At shAmt === 0 both are exact no-ops (dirW 1, injection 0).
  // (Reconciled from Pulse Forge hardening audit, 2026-09-05.)
  let shInj = 0;
  let shDirW = 1;
  let shDirWFreeze = 1;
  let shQuality = 1;
  let shSingle = false;
  let freeze_ = false;

  let modRateHz = 0;
  let modDepthSamples = 0;
  let lfoPhase = 0;

  // ── Always-on air modulation (mirrors plateChamberEngine.ts; the
  // longer hall tails get a touch more smear) ──
  const AIR_DEPTH_A = 0.26;
  const AIR_DEPTH_B = 0.17;
  const AIR_RATE_A = 0.73; // Hz
  const AIR_RATE_B = 1.13; // Hz
  let airPhaseA = 0;
  let airPhaseB = 0;
  let airIncA = 0;
  let airIncB = 0;

  // ── Drive (in-loop saturation) — see plateChamberEngine.ts ──
  let driveGain = 1;
  let driveComp = 1;
  let lfoInc = 0;

  let predelayBufs: Float32Array[][] = [];
  let predelayIdx: number[][] = [];

  let lowSplitL: BiquadState = createBiquad(2);
  let highSplitL: BiquadState = createBiquad(2);
  let lowSplitR: BiquadState = createBiquad(2);
  let highSplitR: BiquadState = createBiquad(2);

  interface AlgoTuning {
    lenMult: number;
    dampHz: number;
    hpHz: number;
  }

  const ALGO_TUNING: Record<Engine3Algo, AlgoTuning> = {
    largeChamber: { lenMult: 0.95, dampHz: 4500, hpHz: 150 },
    hall: { lenMult: 1.0, dampHz: 3500, hpHz: 130 },
  };

  function algoTuning(algo: Engine3Algo): AlgoTuning {
    return ALGO_TUNING[algo];
  }

  function recompute(): void {
    const t = algoTuning(params.algo);
    srScale = (sampleRate / 44100) * t.lenMult;
    const decaySec = clamp(params.time, 4170, 24000) / 1000;

    let avgLen = 0;
    let lensChanged = false;
    for (let c = 0; c < 2; c++) {
      const base = c & 1 ? BASE_LENGTHS_R : BASE_LENGTHS_L;
      for (let l = 0; l < FDN_LINES; l++) {
        const densityScale = 1 - l * 0.03;
        oldLengthsC[c][l] = lengthsC[c][l];
        const nl = Math.max(8, Math.round(base[l] * srScale * densityScale));
        if (nl !== lengthsC[c][l]) lensChanged = true;
        lengthsC[c][l] = nl;
        avgLen += lengthsC[c][l];
      }
    }
    avgLen /= FDN_LINES * 2;

    // Arm the length crossfade only when a length actually moved (a pure
    // damping/shimmer change must not re-blend taps). prepare() clears the
    // fade after its initial recompute.
    if (lensChanged && hasRendered) {
      lensFadeLen = Math.max(1, Math.round(0.02 * sampleRate));
      lensFadeRemaining = lensFadeLen;
    }

    const damp = (clamp(params.dampingAmount, 1, 11) - 1) / 10;
    const cutoffHz = clamp(params.dampingFreqHz, 30, 20000);
    dampAlpha = q32(clamp((1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)) * (0.3 + damp * 0.7), 1e-6, 1));
    hpCoef = q32(Math.exp((-TAU * FDN_HP_HZ) / sampleRate));

    // T60 calibration - mirrors plateChamberEngine.ts exactly: pure
    // per-pass target, NO scalar damping-loss compensation (a scalar
    // boost tilts the loop into a low-band hump that stretches the tail
    // far past the requested T60; see plateChamberEngine.ts).
    feedbackGain = clamp(q32(Math.pow(0.001, avgLen / (decaySec * sampleRate))), 0, 0.99);

    diffG = 0.3 + 0.45 * (clamp(params.diffusion, 0, 100) / 100);
    shAmt = clamp(params.shimmer, 0, 1);

    // ── O3/O4: per-band decay targets with analytic loss compensation ──
    // Pure per-band per-pass targets: band gain g such that fb·g equals
    // the loop gain of a reverb with T60·multiplier. Mirrors plate.
    const bandTarget = (mult: number): number =>
      Math.pow(0.001, avgLen / (decaySec * clamp(mult, 0.25, 4)) / sampleRate) / feedbackGain;
    bassAlpha = q32(1 - Math.exp((-TAU * BASS_SHELF_HZ) / sampleRate));
    midAlpha = q32(1 - Math.exp((-TAU * MID_XOVER_HZ) / sampleRate));

    // O4 calibration: measure the in-loop filter losses ANALYTICALLY at
    // each band's reference frequency (damper one-pole at dampAlpha + the
    // 30 Hz loop high-pass) and divide them out of that band's gain. The
    // historical warning about scalar broadband compensation (200–800 Hz
    // hump from over-boosting the loss-free low band) does not apply:
    // each band is compensated at its OWN reference frequency, so the mid
    // band hits the requested T60 and the low band tracks bassDecay
    // relative to it. The high band stays uncompensated — the damper
    // there is the intended HF decay shaping.
    const dampMagAt = (w: number): number => {
      const b = 1 - dampAlpha;
      return dampAlpha / Math.sqrt(1 - 2 * b * Math.cos(w) + b * b);
    };
    // Mid-band damper deficit measured on SOLO-engine renders (roadmap O4):
    // the broadband EDC regression sees only a FRACTION of the per-pass
    // damper loss at MID_REF (the −5..−35 dB window mixes band slopes),
    // hence the sub-linear exponent O4_BETA instead of a full 1/loss
    // compensation. Low band is NOT loss-compensated: the 30 Hz loop HP
    // rumble cut is intentional, and scalar compensation of a
    // frequency-dependent loss over-boosts above the reference (measured
    // runaway: fb·gLow = 1.09 with full 1/lowLoss).
    const midLoss = dampMagAt((TAU * MID_REF_HZ) / sampleRate);
    const midComp = 1 / Math.pow(midLoss, O4_BETA);
    // HARD loop-safety cap: the compensated loop gain must stay below
    // unity in every band (measured runaway without this: fb·gLow = 1.09).
    const gCap = 0.995 / feedbackGain;
    bassGain = q32(clamp(bandTarget(params.bassDecay), 0.25, Math.min(2.5, gCap)));
    midBandGain = q32(clamp(bandTarget(params.midDecay ?? 1) * midComp, 0.25, Math.min(2.5, gCap)));

    // SHIMMER STABILITY GUARD. The octave-up grain is injected INSIDE the
    // feedback loop (eff = direct + inj·shifted, then ×fb), and the
    // Householder matrix passes the all-lines-equal (common-mode)
    // component — exactly what the injection creates — with unity gain,
    // so the worst-case per-pass loop gain is fb·(dirW + √2·inj): the
    // dual grain taps read the SAME buffer W/2 apart, and octave-up
    // feedback correlates them, giving a coherent amplitude sum g0+g1 ≤
    // √2 (not the decorrelated √(g0²+g1²) = 1). Measured: unguarded,
    // shimmer ≥ ~0.35 at most decay times runs away and overflows the
    // float32 delay lines to Inf/NaN within seconds (the output limiter
    // cannot see the internal loop). dirW attenuates the direct feedback
    // just enough to keep the loop decaying (bass shelf included via
    // fbMax; freeze runs at unity). Below the stability boundary
    // dirW === 1 and the audio is bit-identical to the unguarded engine.
    // O5 voicing: CAP the injection so the direct feedback keeps ≥90%
    // weight. Measured (O1 harness): with a plain 0.5·shAmt injection the
    // guard dropped dirW to ~0.4 at high shimmer and a 6 s tail collapsed
    // to 0.51 s — the reverb body was slaughtered to feed the grain.
    // Short decays (small fb) still get the full injection: they have
    // loop-gain headroom; long decays saturate the injection instead.
    const dirWFloor = 0.9;
    const fbMax = feedbackGain * Math.max(1, bassGain, midBandGain);
    const injMax = Math.max(0, 0.995 / Math.max(fbMax, 1e-6) - dirWFloor) / Math.SQRT2;
    shInj = Math.min(0.5 * shAmt, injMax);
    shDirW = shAmt > 0 ? Math.min(1, 0.995 / Math.max(fbMax, 1e-6) - Math.SQRT2 * shInj) : 1;
    shDirWFreeze = shAmt > 0 ? Math.min(1, 0.995 - Math.SQRT2 * shInj) : 1;

    attackAlpha = q32(1 - Math.exp(-1 / Math.max(0.001, (params.attack / 1000) * sampleRate)));
    // A poisoned envelope (NaN from a non-finite alpha) latches forever:
    // `attackEnv < 1` is false for NaN, so the build-up branch never runs
    // and the engine outputs NaN until reset. setParams → recompute() is
    // the one guaranteed point where a heal can ride a parameter change.
    if (!Number.isFinite(attackEnv)) attackEnv = 0;

    airIncA = q32((TAU * AIR_RATE_A) / sampleRate);
    airIncB = q32((TAU * AIR_RATE_B) / sampleRate);

    const driveT = clamp(params.drive, 0, 1);
    // Tail levels live at −30..−60 dBFS: the pre-gain must be large
    // enough to push them into the tanh knee (unity small-signal gain
    // via driveComp keeps the calibrated decay intact).
    driveGain = 1 + driveT * 63;
    driveComp = 1 / driveGain;

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
    midLp = [];
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
      const base = c & 1 ? BASE_LENGTHS_R : BASE_LENGTHS_L;
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
        // +96 headroom covers the O6 extended modulation depth (<=88)
        // plus Hermite read overshoot; power-of-two caps absorb it.
        const maxLen = Math.max(8, Math.round(base[l] * maxSrScale * densityScale)) + 96;
        ls.push(new Float32Array(maxLen));
        wi.push(0);
        lp.push(0);
        hp.push(0);
        hpv.push(0);
        blp.push(0);
        pdBufs.push(new Float32Array(Math.max(4, Math.round(maxPredelay * maxSrScale))));
        pdIdx.push(0);
      }
      lines.push(ls);
      writeIdx.push(wi);
      lpState.push(lp);
      hpState.push(hp);
      hpPrev.push(hpv);
      bassLp.push(blp);
      midLp.push(blp.map(() => 0));
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
    for (const mlp of midLp) for (let l = 0; l < mlp.length; l++) mlp[l] = 0;
    for (const stages of diffBufs) for (const buf of stages) buf.fill(0);
    for (const idxs of diffIdx) for (let s = 0; s < idxs.length; s++) idxs[s] = 0;
    shBuf[0].fill(0);
    shBuf[1].fill(0);
    shW[0] = 0;
    shW[1] = 0;
    shPhase[0] = 0;
    shPhase[1] = 0;
    lfoPhase = 0;
    airPhaseA = 0;
    airPhaseB = 0;
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
      idxs[s] = (idxs[s] + 1) % len;
      x = out;
    }
    return x;
  }

  // Scalar-only shimmer window sizing (no realloc — the ring is allocated
  // for the largest tier in prepare()). Mirrors plateChamberEngine.ts.
  function applyShimmerWindow(): void {
    shWindow = Math.max(2048, Math.round((SH_WIN_BASE * SH_WIN_MULT[shQuality] * sampleRate) / 48000) & ~1);
    if (shWindow > shWinMax) shWindow = shWinMax;
  }

  return {
    prepare(sr, cc) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      allocChannels(channelCount);
      recompute();
      lensFadeRemaining = 0;
      hasRendered = false;
      attackEnv = 0;
      lfoPhase = 0;
      airPhaseA = 0;
      airPhaseB = 0;
      // Allocate the shimmer ring for the LARGEST quality tier so
      // setQuality() stays a scalar-only realtime operation.
      shWinMax = Math.max(2048, Math.round((2 * SH_WIN_BASE * sampleRate) / 48000) & ~1);
      shBuf = [new Float32Array(2 * shWinMax), new Float32Array(2 * shWinMax)];
      applyShimmerWindow();
      shW[0] = 0;
      shW[1] = 0;
      shPhase[0] = 0;
      shPhase[1] = 0;
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
      // Zero channels would crash the write-back (channels[0] undefined).
      if (!params.enabled || frameCount <= 0 || channels.length === 0) return;
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
      // FREEZE per-band safety. The non-freeze loop gain cap (gCap =
      // 0.995/fb) permits band gains up to 2.5 because the feedback gain
      // multiplies them DOWN; under freeze the loop runs at unity
      // (fbEff = 1.0), so a band gain above 1 is a per-pass gain above 1
      // and the tail grows until the output limiter pins it at the
      // ceiling — measured 0.38–0.48 RMS sustained at bassDecay ≥ 2
      // instead of the documented infinite hold. Clamp every band to
      // unity in freeze: the hold is then a true repeat (no growth).
      // (Reconciled from Pulse Forge audit, 2026-09-19.)
      const bassGainF = freeze_ ? Math.min(bassGain, 1) : bassGain;
      const midBandGainF = freeze_ ? Math.min(midBandGain, 1) : midBandGain;
      // Direct-feedback weight from the shimmer stability guard (1.0 when
      // shimmer is off or inside the stable region — bit-identical path).
      const shDirWCur = freeze_ ? shDirWFreeze : shDirW;
      const effectiveDepth = modDepthSamples;
      // Stereo width: cross-feed of the damped feedback between the L/R
      // loops. 1 = fully independent (widest), 0 = mono feedback.
      // Stereo width (Valhalla convention) — mirrors plateChamberEngine.
      const width = clamp(params.stereoWidth, 0, 1);

      // Hermite read at a given line length (used for the new length and,
      // during a length crossfade, the previous length too).
      const readTap = (buf: Float32Array, w: number, baseLen: number, modOffset: number): number => {
        let readPos = modOffset !== 0 ? w - baseLen + modOffset : w - baseLen;
        const bufLen = buf.length;
        readPos = ((readPos % bufLen) + bufLen) % bufLen;
        const ri0 = Math.floor(readPos);
        const ri1 = (ri0 + 1) % bufLen;
        const frac = readPos - ri0;
        if (frac > 0) {
          const rim1 = (ri0 + bufLen - 1) % bufLen;
          const ri2 = (ri0 + 2) % bufLen;
          return hermiteInterp(buf[rim1], buf[ri0], buf[ri1], buf[ri2], frac);
        }
        return buf[ri0];
      };

      for (let i = 0; i < frameCount; i++) {
        if (attackEnv < 1) {
          attackEnv += attackAlpha * (1 - attackEnv);
          if (attackEnv > 1) attackEnv = 1;
        }

        // Air LFOs advance once per sample (shared by both channels).
        airPhaseA += airIncA;
        if (airPhaseA >= TAU) airPhaseA -= TAU;
        airPhaseB += airIncB;
        if (airPhaseB >= TAU) airPhaseB -= TAU;
        const airOffA = q32(Math.sin(airPhaseA)) * AIR_DEPTH_A;
        const airOffB = q32(Math.sin(airPhaseB)) * AIR_DEPTH_B;

        // ── Per channel: input → diffusor → per-line predelay → taps → damp ──
        for (let c = 0; c < cc; c++) {
          const ls = lines[c];
          const wis = writeIdx[c];
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
            const pdLen = pdBuf.length;
            pdBuf[pdIdx[l]] = inSample;
            const pdOffset = Math.min(LINE_PREDELAY_OFFSETS[l], pdLen - 1);
            const pdRead = (pdIdx[l] - pdOffset + pdLen) % pdLen;
            const delayedIn = pdBuf[pdRead];
            pdIdx[l] = (pdIdx[l] + 1) % pdLen;
            pd[l] = delayedIn;

            const baseLen = lengthsC[c][l];
            let modOffset = 0;
            if (effectiveDepth > 0) {
              const modPhase = lfoPhase + (l / FDN_LINES) * Math.PI * 2;
              modOffset = q32(Math.sin(modPhase)) * effectiveDepth;
            }
            modOffset += l & 1 ? airOffB : airOffA;
            taps[l] = readTap(ls[l], wis[l], baseLen, modOffset);
            if (lensFadeRemaining > 0) {
              // Length crossfade: blend the previous read distance out.
              const t = lensFadeRemaining / lensFadeLen;
              const oldTap = readTap(ls[l], wis[l], oldLengthsC[c][l], modOffset);
              taps[l] = taps[l] * (1 - t) + oldTap * t;
            }
          }
          householderN(taps);

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
            const i0 = (((shW[c] - d0) % size) + size) % size;
            const ph1 = (ph + W / 2) % W;
            const d1 = W - ph1;
            const i1 = (((shW[c] - d1) % size) + size) % size;
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
          const blp = bassLp[c];
          const mlp = midLp[c];
          const damped = dampedScratchC[c];
          const dampedO = dampedScratchC[cc > 1 ? 1 - c : c];
          const pd = pdScratchC[c];
          for (let l = 0; l < FDN_LINES; l++) {
            const direct = width * damped[l] + (1 - width) * 0.5 * (damped[l] + dampedO[l]);
            // Shimmer INJECTS the octave-up grain as extra loop input —
            // the direct feedback stays intact so loop gain never exceeds
            // fb (stable), and the pitched content re-enters the shifter
            // on later passes (the classic cascading shimmer buildup).
            // Shimmer INJECTS the octave-up grain as extra loop input —
            // the pitched content re-enters the shifter on later passes
            // (the classic cascading shimmer buildup). The direct feedback
            // weight comes from the stability guard in recompute(): the
            // injection is inside the loop, so without the guard the
            // per-pass gain exceeds 1 and the lines overflow. At zero
            // shimmer this reduces to `direct`.
            const eff = shDirWCur * direct + shInj * shiftedC[c];
            // O3 complementary 3-band split: low + mid + high === eff
            // (sample-exact), so the network only re-weights the decay
            // per band and collapses to the historical bass shelf when
            // midBandGain === 1.
            blp[l] += bassAlpha * (eff - blp[l]);
            blp[l] = flushDenormal(blp[l]);
            const lowBand = sanitize(blp[l]);
            const lowHp = eff - lowBand;
            mlp[l] += midAlpha * (lowHp - mlp[l]);
            mlp[l] = flushDenormal(mlp[l]);
            const midBand = sanitize(mlp[l]);
            let shelved = lowBand * bassGainF + midBand * midBandGainF + (lowHp - midBand);
            if (driveGain > 1.0001) {
              const hot = shelved * driveGain;
              const hot2 = hot * hot;
              shelved = ((hot * (27 + hot2)) / (27 + 9 * hot2)) * driveComp;
            }
            ls[l][wis[l]] = pd[l] + shelved * fbEff;
            wis[l] = (wis[l] + 1) % ls[l].length;
          }
          const out = c === 0 ? wetL : wetR;
          if (out) out[i] = (wetSumC[c] / FDN_LINES) * attackEnv * DENSITY_GAIN;
        }

        lfoPhase += lfoInc;
        if (lfoPhase >= Math.PI * 2) lfoPhase -= Math.PI * 2;
        if (lensFadeRemaining > 0) lensFadeRemaining--;
      }
      hasRendered = true;

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
      // NOTE: no attackEnv reset here — resetting the build-up envelope on
      // every engine-parameter change ducked the tail during any time/size
      // automation (audible pumping). The envelope initializes on
      // prepare()/reset() only. Length changes morph click-free via the
      // length crossfade instead.
    },

    setModulation(rateHz: number, depthSamples: number, maxDepth?: number) {
      modRateHz = clamp(rateHz, 0, 20);
      // Roadmap O6: caller-declared depth ceiling (mod.maxDepthSamples),
      // bounded by the delay-line headroom so Hermite reads never wrap.
      modDepthSamples = clamp(depthSamples, 0, Math.min(maxDepth ?? 20, 88));
      lfoInc = (modRateHz * 0.7 * 2 * Math.PI) / sampleRate;
    },

    getLatencySamples() {
      return 0;
    },

    reset() {
      resetState();
      attackEnv = 0;
      lensFadeRemaining = 0;
      hasRendered = false;
      lowSplitL.z1.fill(0);
      lowSplitL.z2.fill(0);
      highSplitL.z1.fill(0);
      highSplitL.z2.fill(0);
      lowSplitR.z1.fill(0);
      lowSplitR.z2.fill(0);
      highSplitR.z1.fill(0);
      highSplitR.z2.fill(0);
    },
  };
}
