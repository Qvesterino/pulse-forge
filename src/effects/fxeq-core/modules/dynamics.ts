/* eslint-disable */
// @ts-nocheck
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
// FXEQ — Dynamics module (compressor / expander / de-esser)
//
// Feed-forward dynamics processor with soft-knee gain computer,
// RMS/peak envelope follower, and optional sidechain band-pass
// filter for de-esser operation.
//
//   0 — Compressor:  standard feed-forward compressor
//   1 — Expander:    downward expander / noise gate
//   2 — De-Esser:    compressor with sidechain HP emphasis (4–8 kHz)
//
// Stereo modes:
//   0 — Stereo linked: single envelope across L/R
//   1 — Mid/Side: independent compression for M and S channels
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import { clamp, dbToLinear, linearToDb } from "../dsp/mathUtils.js";
import { createParamStore } from "./moduleHelpers.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";

export const DYNAMICS_TYPE_ID = "dynamics";

const PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "enabled", name: "Enabled", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "type", name: "Type", defaultValue: 0, minValue: 0, maxValue: 2, automatable: false },
  {
    id: "stereoMode",
    name: "Stereo Mode",
    defaultValue: 0,
    minValue: 0,
    maxValue: 1,
    automatable: false,
  },
  {
    id: "threshDb",
    name: "Threshold",
    defaultValue: -24,
    minValue: -60,
    maxValue: 0,
    unit: "dB",
    automatable: true,
  },
  {
    id: "ratio",
    name: "Ratio",
    defaultValue: 4,
    minValue: 1,
    maxValue: 20,
    unit: ":1",
    automatable: true,
  },
  {
    id: "atkMs",
    name: "Attack",
    defaultValue: 5,
    minValue: 0.1,
    maxValue: 50,
    unit: "ms",
    automatable: true,
  },
  {
    id: "relMs",
    name: "Release",
    defaultValue: 80,
    minValue: 10,
    maxValue: 500,
    unit: "ms",
    automatable: true,
  },
  {
    id: "kneeDb",
    name: "Knee",
    defaultValue: 6,
    minValue: 0,
    maxValue: 12,
    unit: "dB",
    automatable: true,
  },
  {
    id: "makeupDb",
    name: "Makeup",
    defaultValue: 0,
    minValue: 0,
    maxValue: 24,
    unit: "dB",
    automatable: true,
  },
  {
    id: "sideThreshDb",
    name: "Side Threshold",
    defaultValue: -24,
    minValue: -60,
    maxValue: 0,
    unit: "dB",
    automatable: true,
  },
  {
    id: "sideRatio",
    name: "Side Ratio",
    defaultValue: 2,
    minValue: 1,
    maxValue: 20,
    unit: ":1",
    automatable: true,
  },
  {
    id: "sideMakeupDb",
    name: "Side Makeup",
    defaultValue: 0,
    minValue: 0,
    maxValue: 24,
    unit: "dB",
    automatable: true,
  },
  {
    id: "mix",
    name: "Mix",
    defaultValue: 100,
    minValue: 0,
    maxValue: 100,
    unit: "%",
    automatable: true,
  },
] as const;

export function createDynamicsModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let sampleRate = 44100;
  let preparedMaxBlockSize = 1;

  // Per-channel envelope state.
  let envDb: number[] = [];
  // M/S mode: separate envelope for Side channel.
  let envSideDb = -100;
  // De-esser sidechain filter state (per-channel, 2-pole HP emphasis).
  let scHp1: number[] = [];
  let scHp2: number[] = [];
  let scPrev1: number[] = [];
  let scPrev2: number[] = [];
  // Dry snapshot for parallel mix.
  let dryBuf: Float32Array[] = [];
  // M/S scratch buffers.
  let msBufM: Float32Array = new Float32Array(0);
  let msBufS: Float32Array = new Float32Array(0);
  // Reused M/S parameter bundle — process() runs on the audio thread and
  // must not allocate a fresh object literal per block.
  const msParams: MSProcessParams = {
    threshDb: 0,
    ratio: 1,
    attackCoeff: 1,
    releaseCoeff: 1,
    kneeDb: 0,
    makeupLinear: 1,
    wetGain: 1,
    isExpander: false,
    isDeEsser: false,
  };

  function allocChannels(channelCount: number, maxBlockSize: number): void {
    envDb = [];
    scHp1 = [];
    scHp2 = [];
    scPrev1 = [];
    scPrev2 = [];
    dryBuf = [];
    for (let c = 0; c < channelCount; c++) {
      envDb.push(-100);
      scHp1.push(0);
      scHp2.push(0);
      scPrev1.push(0);
      scPrev2.push(0);
      dryBuf.push(new Float32Array(maxBlockSize));
    }
    envSideDb = -100;
    msBufM = new Float32Array(maxBlockSize);
    msBufS = new Float32Array(maxBlockSize);
  }

  // Soft-knee gain computation (log domain).
  function computeGainDb(
    inputDb: number,
    threshDb: number,
    ratio: number,
    kneeDb: number,
    isExpander: boolean,
  ): number {
    const halfKnee = kneeDb / 2;

    if (!isExpander) {
      // Compressor: reduce gain when input exceeds threshold.
      if (inputDb <= threshDb - halfKnee) {
        return 0;
      }
      if (kneeDb > 0 && inputDb < threshDb + halfKnee) {
        const x = inputDb - threshDb + halfKnee;
        return ((1 / ratio - 1) * (x * x)) / (2 * kneeDb);
      }
      return (1 / ratio - 1) * (inputDb - threshDb);
    }

    // Expander: reduce gain when input falls below threshold.
    if (inputDb >= threshDb + halfKnee) {
      return 0;
    }
    if (kneeDb > 0 && inputDb > threshDb - halfKnee) {
      const x = inputDb - threshDb - halfKnee;
      return ((ratio - 1) * (x * x)) / (2 * kneeDb);
    }
    return (ratio - 1) * (inputDb - threshDb);
  }

  // De-esser sidechain filter coefficients — cached per sample rate
  // (audit minor: the old code recomputed 4× sin/cos PER SAMPLE).
  let scCoeffs: { b0: number; b1: number; b2: number; a1: number; a2: number } | null = null;

  function sidechainCoeffs(): { b0: number; b1: number; b2: number; a1: number; a2: number } {
    if (scCoeffs) return scCoeffs;
    const freq = 5000;
    const q = 0.7071;
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;
    scCoeffs = {
      b0: (1 + cosw0) / 2 / a0,
      b1: -(1 + cosw0) / a0,
      b2: (1 + cosw0) / 2 / a0,
      a1: (-2 * cosw0) / a0,
      a2: (1 - alpha) / a0,
    };
    return scCoeffs;
  }

  // De-esser sidechain: 2nd-order Butterworth HP at ~5 kHz for sibilance detection.
  function processSidechainFilter(x: number, ch: number): number {
    const { b0, b1, b2, a1, a2 } = sidechainCoeffs();

    // Cascade of two 2nd-order Butterworth HP sections for ~24 dB/oct
    // rolloff above the cutoff. The previous implementation declared
    // a second stage but multiplied by zero, leaving the cascade
    // dead (Audit #C2).
    const y1 = b0 * x + scHp1[ch];
    scHp1[ch] = b1 * x - a1 * y1 + scHp2[ch];
    scHp2[ch] = b2 * x - a2 * y1;
    const x2 = y1;
    const y2 = b0 * x2 + scPrev1[ch];
    scPrev1[ch] = b1 * x2 - a1 * y2 + scPrev2[ch];
    scPrev2[ch] = b2 * x2 - a2 * y2;
    return Math.abs(y2);
  }

  interface MSProcessParams {
    threshDb: number;
    ratio: number;
    attackCoeff: number;
    releaseCoeff: number;
    kneeDb: number;
    makeupLinear: number;
    wetGain: number;
    isExpander: boolean;
    isDeEsser: boolean;
  }

  function processMidSide(channels: Float32Array[], frameCount: number, p: MSProcessParams): void {
    const L = channels[0];
    const R = channels[1];
    const inv = 1 / Math.SQRT2;

    const sideThreshDb = clamp(store.get("sideThreshDb"), -60, 0);
    const sideRatio = clamp(store.get("sideRatio"), 1, 20);
    const sideMakeupLinear = dbToLinear(clamp(store.get("sideMakeupDb"), 0, 24));

    // Encode L/R → M/S.
    for (let i = 0; i < frameCount; i++) {
      msBufM[i] = (L[i] + R[i]) * inv;
      msBufS[i] = (L[i] - R[i]) * inv;
    }

    // Compress Mid channel.
    for (let i = 0; i < frameCount; i++) {
      const absM = Math.abs(msBufM[i]);
      const inputDb = linearToDb(Math.max(absM, 1e-10));
      const gainDb = computeGainDb(inputDb, p.threshDb, p.ratio, p.kneeDb, p.isExpander);

      if (gainDb < envDb[0]) {
        envDb[0] = p.attackCoeff * envDb[0] + (1 - p.attackCoeff) * gainDb;
      } else {
        envDb[0] = p.releaseCoeff * envDb[0] + (1 - p.releaseCoeff) * gainDb;
      }

      msBufM[i] *= dbToLinear(envDb[0]) * p.makeupLinear;
    }

    // Compress Side channel (independent envelope).
    for (let i = 0; i < frameCount; i++) {
      const absS = Math.abs(msBufS[i]);
      const inputDb = linearToDb(Math.max(absS, 1e-10));
      const gainDb = computeGainDb(inputDb, sideThreshDb, sideRatio, p.kneeDb, p.isExpander);

      if (gainDb < envSideDb) {
        envSideDb = p.attackCoeff * envSideDb + (1 - p.attackCoeff) * gainDb;
      } else {
        envSideDb = p.releaseCoeff * envSideDb + (1 - p.releaseCoeff) * gainDb;
      }

      msBufS[i] *= dbToLinear(envSideDb) * sideMakeupLinear;
    }

    // Decode M/S → L/R with parallel mix.
    const dry0 = dryBuf[0];
    const dry1 = dryBuf[1];
    for (let i = 0; i < frameCount; i++) {
      const outL = (msBufM[i] + msBufS[i]) * inv;
      const outR = (msBufM[i] - msBufS[i]) * inv;
      L[i] = dry0[i] * (1 - p.wetGain) + outL * p.wetGain;
      R[i] = dry1[i] * (1 - p.wetGain) + outR * p.wetGain;
    }
  }

  return {
    get typeId() {
      return DYNAMICS_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sr, channelCount, maxBlockSize) {
      sampleRate = sr;
      // Audit minor: invalidate the cached de-esser coefficients when the
      // sample rate changes.
      scCoeffs = null;
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      allocChannels(Math.max(1, channelCount), Math.max(1, maxBlockSize));
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "dynamics", dryBuf.length);
      if (frameCount === 0) return;
      if (store.get("enabled") < 0.5) return;

      const type = Math.round(store.get("type"));
      const stereoMode = Math.round(store.get("stereoMode"));
      const threshDb = clamp(store.get("threshDb"), -60, 0);
      const ratio = clamp(store.get("ratio"), 1, 20);
      const attackMs = clamp(store.get("atkMs"), 0.1, 50);
      const releaseMs = clamp(store.get("relMs"), 10, 500);
      const kneeDb = clamp(store.get("kneeDb"), 0, 12);
      const makeupDb = clamp(store.get("makeupDb"), 0, 24);
      const wetGain = clamp(store.get("mix"), 0, 100) / 100;
      const isExpander = type === 1;
      const isDeEsser = type === 2;
      const makeupLinear = dbToLinear(makeupDb);

      const attackCoeff = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
      const releaseCoeff = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));

      const numCh = channels.length;

      for (let c = 0; c < numCh; c++) {
        dryBuf[c].set(channels[c].subarray(0, frameCount));
      }

      if (stereoMode === 1 && numCh >= 2) {
        msParams.threshDb = threshDb;
        msParams.ratio = ratio;
        msParams.attackCoeff = attackCoeff;
        msParams.releaseCoeff = releaseCoeff;
        msParams.kneeDb = kneeDb;
        msParams.makeupLinear = makeupLinear;
        msParams.wetGain = wetGain;
        msParams.isExpander = isExpander;
        msParams.isDeEsser = isDeEsser;
        processMidSide(channels, frameCount, msParams);
        return;
      }

      for (let i = 0; i < frameCount; i++) {
        let peakAbs = 0;
        for (let c = 0; c < numCh; c++) {
          let sample = channels[c][i];

          if (isDeEsser) {
            sample = processSidechainFilter(sample, c);
          } else {
            sample = Math.abs(sample);
          }

          if (c === 0 || sample > peakAbs) peakAbs = sample;
        }

        const inputDb = linearToDb(Math.max(peakAbs, 1e-10));
        const gainDb = computeGainDb(inputDb, threshDb, ratio, kneeDb, isExpander);

        if (gainDb < envDb[0]) {
          envDb[0] = attackCoeff * envDb[0] + (1 - attackCoeff) * gainDb;
        } else {
          envDb[0] = releaseCoeff * envDb[0] + (1 - releaseCoeff) * gainDb;
        }

        const gainLinear = dbToLinear(envDb[0]) * makeupLinear;

        for (let c = 0; c < numCh; c++) {
          const dry = dryBuf[c][i];
          const processed = dry * gainLinear;
          channels[c][i] = dry * (1 - wetGain) + processed * wetGain;
        }
      }
    },

    reset() {
      for (let c = 0; c < envDb.length; c++) {
        envDb[c] = -100;
        scHp1[c] = 0;
        scHp2[c] = 0;
        scPrev1[c] = 0;
        scPrev2[c] = 0;
      }
      // Audit minor: the M/S side envelope lived outside this loop and
      // survived every reset — a mid-song -20 dB side attenuation kept
      // suppressing the side channel after a transport reset.
      envSideDb = -100;
    },

    getLatencySamples() {
      return 0;
    },

    setParameter(id, value) {
      store.set(id, value);
    },
    getParameter(id) {
      return store.get(id);
    },
    getParameters() {
      return store.all();
    },
    loadParameters(p) {
      store.load(p);
    },
  };
}
