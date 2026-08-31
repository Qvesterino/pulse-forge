/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// FXEQ — Multiband crossover bank
//
// Splits an input signal into up to 6 bands using a cascade tree of
// Linkwitz-Riley stages. For N bands there are N-1 crossover stages at
// frequencies f[0] < f[1] < ... < f[N-2].
//
// Progressive algorithm (power-complementary cascade tree):
//   working = input
//   for k in 0..N-2:
//     band[k]   = LP(stage_k)(working)   // low tap
//     working   = HP(stage_k)(working)   // remainder
//   band[N-1] = working                  // top band = remainder
//
// This yields:
//   band[k]   = HP_0·HP_1·...·HP_{k-1}·LP_k
//   band[N-1] = HP_0·...·HP_{N-2}
//
// Allpass equalization (optional, default ON): each band that taps early
// is passed through the complementary allpass of every higher split so
// that all bands share an identical group-delay path. The summed output
// then becomes a single global allpass (flat magnitude, consistent
// phase), so the crossover is audibly transparent when all effects are
// bypassed — impulses reconstruct as one aligned smear instead of a
// multi-hump spread.
//
// For LR4, the complementary allpass at split j equals two cascaded
// 2nd-order allpass sections (Q = 1/√2), which share the LR4 pole
// structure and realise LP4_j + HP4_j.
// ═══════════════════════════════════════════════════════════

import {
  type CrossoverStage,
  type CrossoverOrder,
  createCrossoverStage,
  tuneCrossoverStage,
  resetCrossoverStage,
  applyLpBranch,
  applyHpBranch,
} from "../dsp/crossoverStage.js";
import { clamp, DEFAULT_SAMPLE_RATE } from "../dsp/mathUtils.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";

export const MAX_BANDS = 6;

/** Default crossover frequencies for a 6-way split (Hz). */
export const DEFAULT_CROSSOVER_FREQS = [120, 400, 1200, 4000, 8000];

export interface CrossoverBank {
  readonly bandCount: number;
  readonly order: CrossoverOrder;
  /** Number of samples of filter group delay introduced (for PDC). */
  getLatencySamples(): number;
  prepare(sampleRate: number, channelCount: number, maxBlockSize: number): void;
  setBandCount(count: number): void;
  /** Set the i-th crossover frequency (0-indexed, 0..bandCount-2). */
  setCrossoverFreq(index: number, freqHz: number): void;
  setCrossoverFreqs(freqs: number[]): void;
  /** Enable/disable allpass phase equalization (default: enabled). */
  setEqualize(enabled: boolean): void;
  reset(): void;
  /**
   * Split `input` into the bank's internal band buffers. After this call,
   * `getBand(i)` returns a read-only view of band i's channel data.
   */
  process(input: Float32Array[], frameCount: number): void;
  /** Read-only access to band i channel data (valid after process()). */
  getBand(index: number): Float32Array[];
}

export function createCrossoverBank(
  initialBandCount = 6,
  order: CrossoverOrder = 4,
  initialFreqs: number[] = [...DEFAULT_CROSSOVER_FREQS],
): CrossoverBank {
  let bandCount = clamp(initialBandCount, 2, MAX_BANDS);
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let channelCount = 2;
  let prepared = false;
  let preparedMaxBlockSize = 1;

  // N-1 stages, always allocated for MAX_BANDS so band-count changes are cheap.
  const stages: CrossoverStage[] = [];
  const freqs: number[] = [...DEFAULT_CROSSOVER_FREQS];
  for (let i = 0; i < initialFreqs.length && i < freqs.length; i++) {
    freqs[i] = initialFreqs[i];
  }

  // Band output buffers + scratch. Lazily sized in prepare().
  let bandBuffers: Float32Array[][] = [];
  let working: Float32Array[] = [];
  let scratch: Float32Array[] = [];

  // ── Allpass equalization ────────────────────────────────────
  // For each crossover stage j (0..MAX_BANDS-2) we keep a dedicated
  // compensation CrossoverStage (independent LP+HP biquad state) so the
  // complementary allpass A_j = LP4_j + HP4_j can be applied to early-tap
  // bands without corrupting the cascade tree's own filter state.
  // Band k is compensated by A_{k+1} … A_{N-2} so that every band
  // traverses an identical group-delay path.
  let equalize = true;
  // Per-band compensation stages: compStagesPerBand[k][j] is the comp stage
  // for band k using crossover frequency j. Each band has independent biquad
  // state so that block-size chunking does not corrupt filter state across
  // bands (the comp stage for frequency j is used by multiple bands, and
  // sharing state would make the processing order-dependent).
  const compStagesPerBand: CrossoverStage[][] = [];
  let compLp: Float32Array[] = [];
  let compHp: Float32Array[] = [];

  function rebuildStages(): void {
    // Always keep MAX_BANDS-1 stages around; only the first (bandCount-1) are tuned.
    while (stages.length < MAX_BANDS - 1) {
      stages.push(createCrossoverStage(channelCount, order));
    }
    for (let i = 0; i < bandCount - 1; i++) {
      tuneCrossoverStage(stages[i], clampFreq(freqs[i]), sampleRate, order);
    }
    // Build / re-tune per-band compensation stages.
    // Each band k needs comp stages for frequencies j ∈ [k+1, bandCount-2].
    // We allocate MAX_BANDS entries; each is an array indexed by comp-stage j.
    while (compStagesPerBand.length < MAX_BANDS) {
      const arr: CrossoverStage[] = [];
      while (arr.length < MAX_BANDS - 1) {
        arr.push(createCrossoverStage(channelCount, order));
      }
      compStagesPerBand.push(arr);
    }
    for (let k = 0; k < MAX_BANDS; k++) {
      for (let j = 0; j < MAX_BANDS - 1; j++) {
        tuneCrossoverStage(compStagesPerBand[k][j], clampFreq(freqs[j]), sampleRate, order);
      }
    }
  }

  function clampFreq(f: number): number {
    return clamp(f, 40, sampleRate * 0.49);
  }

  function ensureBuffers(maxBlockSize: number): void {
    bandBuffers = [];
    for (let b = 0; b < MAX_BANDS; b++) {
      const chans: Float32Array[] = [];
      for (let c = 0; c < channelCount; c++) {
        chans.push(new Float32Array(maxBlockSize));
      }
      bandBuffers.push(chans);
    }
    working = [];
    scratch = [];
    for (let c = 0; c < channelCount; c++) {
      working.push(new Float32Array(maxBlockSize));
      scratch.push(new Float32Array(maxBlockSize));
    }
    compLp = [];
    compHp = [];
    for (let c = 0; c < channelCount; c++) {
      compLp.push(new Float32Array(maxBlockSize));
      compHp.push(new Float32Array(maxBlockSize));
    }
  }

  return {
    get bandCount() {
      return bandCount;
    },
    get order() {
      return order;
    },

    getLatencySamples() {
      // LR4 group delay is small and equalised per-band by the band engine's
      // own delay compensation; the bank itself contributes ~0 net latency
      // because all bands share the cascade topology.
      return 0;
    },

    prepare(sr, cc, maxBlockSize) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      ensureBuffers(preparedMaxBlockSize);
      rebuildStages();
      prepared = true;
    },

    setBandCount(count) {
      bandCount = clamp(count, 2, MAX_BANDS);
      if (prepared) rebuildStages();
    },

    setCrossoverFreq(index, freqHz) {
      if (index < 0 || index >= freqs.length) return;
      freqs[index] = freqHz;
      if (!prepared || index >= bandCount - 1) return;
      tuneCrossoverStage(stages[index], clampFreq(freqHz), sampleRate, order);
      // Audit C3: the per-band allpass compensation stages for this split
      // frequency must be retuned along with the main stage. Bands
      // 0..index-1 lean on A_index for their phase path; leaving them at
      // the old frequency broke phase alignment and combed the summed
      // output after every interactive crossover drag. This is the hot
      // path — the per-block crossover smoothing in fxEqProcessor lands
      // here, so only the affected split is retuned (no rebuildStages).
      for (let k = 0; k < MAX_BANDS; k++) {
        tuneCrossoverStage(compStagesPerBand[k][index], clampFreq(freqHz), sampleRate, order);
      }
    },

    setCrossoverFreqs(freqArr) {
      for (let i = 0; i < freqArr.length && i < freqs.length; i++) {
        freqs[i] = freqArr[i];
      }
      if (prepared) rebuildStages();
    },

    reset() {
      for (let i = 0; i < stages.length; i++) resetCrossoverStage(stages[i]);
      for (const chans of bandBuffers) for (const c of chans) c.fill(0);
      for (const c of working) c.fill(0);
      for (const c of scratch) c.fill(0);
      for (const arr of compStagesPerBand) for (const st of arr) resetCrossoverStage(st);
    },

    setEqualize(enabled: boolean) {
      equalize = enabled;
    },

    process(input, frameCount) {
      if (!prepared) return;
      assertAudioBlock(input, frameCount, preparedMaxBlockSize, "crossover", channelCount);
      if (frameCount === 0) return;

      // Seed the working buffer with the input.
      for (let c = 0; c < channelCount; c++) {
        working[c].set(input[c].subarray(0, frameCount));
      }

      // Tap low bands progressively.
      for (let k = 0; k < bandCount - 1; k++) {
        const band = bandBuffers[k];
        // band = LP(stage_k)(working)
        applyLpBranch(stages[k], working, band, frameCount);
        // working = HP(stage_k)(working) — filter into scratch, then swap back.
        applyHpBranch(stages[k], working, scratch, frameCount);
        const tmp = working;
        working = scratch;
        scratch = tmp;
      }
      // Top band = remaining working signal.
      const top = bandBuffers[bandCount - 1];
      for (let c = 0; c < channelCount; c++) {
        top[c].set(working[c].subarray(0, frameCount));
      }

      // ── Allpass equalization ─────────────────────────────────
      // Band k (0-indexed) tapped after k HP stages + 1 LP. It needs the
      // complementary allpass A_j = LP4_j + HP4_j of every higher split
      // j ∈ [k+1, N-2] applied, so all bands share the same phase path.
      if (equalize) {
        for (let k = 0; k < bandCount; k++) {
          const bandBuf = bandBuffers[k];
          for (let j = k + 1; j <= bandCount - 2; j++) {
            const st = compStagesPerBand[k][j];
            // A_j(band) = LP4_j(band) + HP4_j(band)
            applyLpBranch(st, bandBuf, compLp, frameCount);
            applyHpBranch(st, bandBuf, compHp, frameCount);
            for (let c = 0; c < channelCount; c++) {
              const lp = compLp[c];
              const hp = compHp[c];
              const dst = bandBuf[c];
              for (let i = 0; i < frameCount; i++) {
                dst[i] = lp[i] + hp[i];
              }
            }
          }
        }
      }
    },

    getBand(index) {
      return bandBuffers[index] ?? [];
    },
  };
}
