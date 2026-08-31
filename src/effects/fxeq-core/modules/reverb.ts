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
// FXEQ — Reverb module (Feedback Delay Network)
//
// A 4-line FDN with a Hadamard feedback matrix and per-line damping.
// Each type presets the delay lengths, decay scaling, and damping to
// evoke a distinct space:
//   0 — Plate:  short, dense, bright, metallic-tinged
//   1 — Hall:   longer, with pre-delay, diffuse tail
//   2 — Spring: short, resonant all-pass-flavoured tank
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import { clamp, flushDenormal } from "../dsp/mathUtils.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";
import { createParamStore } from "./moduleHelpers.js";

export const REVERB_TYPE_ID = "reverb";

const FDN_LINES = 4;

const PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "enabled", name: "Enabled", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "type", name: "Type", defaultValue: 0, minValue: 0, maxValue: 2, automatable: false },
  { id: "decayMs", name: "Decay", defaultValue: 1500, minValue: 100, maxValue: 8000, unit: "ms", logScale: true, automatable: true },
  { id: "predelayMs", name: "Pre-Delay", defaultValue: 20, minValue: 0, maxValue: 100, unit: "ms", automatable: true },
  { id: "mix", name: "Mix", defaultValue: 25, minValue: 0, maxValue: 100, unit: "%", automatable: true },
] as const;

// Prime-number delay lengths (samples @ 44.1 kHz) for incommensurate tails.
// Stereo decorrelated: L and R use different mutually-incommensurate prime sets
// so the two FDN tanks diverge, producing natural stereo width.
const BASE_LENGTHS_L = [1116, 1188, 1277, 1356];
const BASE_LENGTHS_R = [1422, 1491, 1557, 1617];

export function createReverbModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let sampleRate = 44100;
  let preparedMaxBlockSize = 1;

  // Per-channel FDN state.
  const lines: Float32Array[][] = []; // [channel][line]
  const writeIdx: number[][] = [];
  const lpState: number[][] = []; // [channel][line] damping LPF state
  const hpState: number[][] = []; // [channel][line] low-cut HPF state
  const hpPrev: number[][] = []; // [channel][line] previous input to HPF
  let lengths: number[] = [];
  let fbGainsL: number[] = [];
  let fbGainsR: number[] = [];
  let dampAlpha = 0.5; // HF damping
  let hpAlpha = 0; // LF cut
  let srScale = 1;

  // Per-channel predelay line (circular buffer).
  let predelayLines: Float32Array[] = []; // [channel]
  let predelayWriteIdx: number[] = [];   // [channel]
  let predelayLen = 0; // in samples

  // Cross-channel coupling buffers (previous block's wet per sample).
  const CROSS_COUPLING = 0.15;
  let crossFeedPrev: Float32Array[] = [];
  let crossFeedCur: Float32Array[] = [];

  // Pre-allocated scratch for FDN tap readout (avoids per-sample allocation).
  const tapsScratch = new Float64Array(FDN_LINES);

  function allocPredelay(channelCount: number): void {
    const predelayMs = clamp(store.get("predelayMs"), 0, 100);
    predelayLen = Math.round((predelayMs / 1000) * sampleRate);
    const maxLen = Math.round((100 / 1000) * sampleRate);
    predelayLines.length = 0;
    predelayWriteIdx.length = 0;
    for (let c = 0; c < channelCount; c++) {
      predelayLines.push(new Float32Array(maxLen));
      predelayWriteIdx.push(0);
    }
  }

  function allocChannels(channelCount: number): void {
    // Audit M1: FDN buffers are allocated ONCE at the maximum possible
    // length (longest base length × largest lenMult 1.4 × rate scale).
    // Type changes then only move the logical delay lengths — no buffer
    // reallocation, no state wipe on the audio thread.
    const maxSrScale = (sampleRate / 44100) * 1.4;
    const maxLen = Math.max(8, Math.round(BASE_LENGTHS_R[3] * maxSrScale)) + 1;
    lines.length = 0;
    writeIdx.length = 0;
    lpState.length = 0;
    hpState.length = 0;
    hpPrev.length = 0;
    for (let c = 0; c < channelCount; c++) {
        const ls: Float32Array[] = [];
        const wi: number[] = [];
        const lp: number[] = [];
        const hp: number[] = [];
        const hpv: number[] = [];
        for (let l = 0; l < FDN_LINES; l++) {
          ls.push(new Float32Array(maxLen));
          wi.push(0);
          lp.push(0);
          hp.push(0);
          hpv.push(0);
        }
        lines.push(ls);
        writeIdx.push(wi);
        lpState.push(lp);
        hpState.push(hp);
        hpPrev.push(hpv);
      }
      // Logical delay lengths for the current srScale (recompute() keeps
      // these in sync; allocChannels must not clobber them with the
      // physical capacity when prepare() calls it after recompute()).
      lengths = [];
      for (let l = 0; l < FDN_LINES; l++) {
        lengths.push(Math.max(8, Math.round(BASE_LENGTHS_L[l] * srScale)));
      }
    }

  function recompute(): void {
    const type = Math.round(store.get("type"));
    const decayMs = clamp(store.get("decayMs"), 100, 8000);
    // RT60 → feedback gain: fb = 0.001^((delayLen*sr) / (decay*samples))
    // Approximate per-line: fb = pow(0.001, lineLen / (decaySec * sampleRate))
    const decaySec = decayMs / 1000;
    // Type tuning.
    let lenMult = 1;
    let dampHz = 5000;
    let hpHz = 200;
    if (type === 0) {
      lenMult = 0.7;
      dampHz = 6500;
      hpHz = 150;
    } else if (type === 1) {
      lenMult = 1.4;
      dampHz = 4500;
      hpHz = 180;
    } else {
      lenMult = 0.45;
      dampHz = 3500;
      hpHz = 250;
    }
    srScale = (sampleRate / 44100) * lenMult;
    dampAlpha = 1 - Math.exp((-2 * Math.PI * dampHz) / sampleRate);
    hpAlpha = Math.exp((-2 * Math.PI * hpHz) / sampleRate);
    // Cross-validation audit: recompute() runs on preset/state loads via
    // loadParameters, but predelayLen was only updated in
    // setParameter("predelayMs") — loading a preset with a different
    // pre-delay kept the OLD delay length until the next UI tweak.
    predelayLen = Math.round((clamp(store.get("predelayMs"), 0, 100) / 1000) * sampleRate);
    // Recompute lengths + per-line feedback gains. The FDN buffers are
    // allocated at max capacity (see allocChannels), so a type/rate
    // change only moves the logical lengths — never reallocates (M1).
    const newLen = [];
    fbGainsL = [];
    fbGainsR = [];
    for (let l = 0; l < FDN_LINES; l++) {
      const lenL = Math.max(8, Math.round(BASE_LENGTHS_L[l] * srScale));
      const lenR = Math.max(8, Math.round(BASE_LENGTHS_R[l] * srScale));
      newLen.push(lenL);
      fbGainsL.push(clamp(Math.pow(0.001, lenL / (decaySec * sampleRate)), 0, 0.99));
      fbGainsR.push(clamp(Math.pow(0.001, lenR / (decaySec * sampleRate)), 0, 0.99));
    }
    lengths = newLen;
    // Keep write cursors inside the (possibly shrunk) logical delays.
    for (let c = 0; c < writeIdx.length; c++) {
      for (let l = 0; l < writeIdx[c].length; l++) {
        writeIdx[c][l] %= lengths[l];
      }
    }
  }

  // Hadamard 4×4 matrix application (in place).
  function hadamard4(v: Float64Array): void {
    const a = v[0], b = v[1], c = v[2], d = v[3];
    v[0] = (a + b + c + d) * 0.5;
    v[1] = (a - b + c - d) * 0.5;
    v[2] = (a + b - c - d) * 0.5;
    v[3] = (a - b - c + d) * 0.5;
  }

  return {
    get typeId() {
      return REVERB_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sr, channelCount, maxBlockSize) {
      sampleRate = sr;
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      recompute();
      allocPredelay(Math.max(1, channelCount));
      // Ensure channel count matches.
      if (lines.length !== Math.max(1, channelCount)) {
        allocChannels(Math.max(1, channelCount));
      }
      crossFeedPrev = [];
      crossFeedCur = [];
      for (let c = 0; c < Math.max(1, channelCount); c++) {
        crossFeedPrev.push(new Float32Array(preparedMaxBlockSize));
        crossFeedCur.push(new Float32Array(preparedMaxBlockSize));
      }
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "reverb", lines.length);
      if (frameCount === 0) return;
      if (store.get("enabled") < 0.5) return;

      const wetGain = clamp(store.get("mix"), 0, 100) / 100;
      const dryGain = 1 - wetGain;
      const numCh = channels.length;
      const hasCoupling = numCh >= 2 && crossFeedPrev.length >= 2;

      for (let c = 0; c < numCh; c++) {
        const buf = channels[c];
        const ls = lines[c];
        const wis = writeIdx[c];
        const lp = lpState[c];
        const hp = hpState[c];
        const hpv = hpPrev[c];
        const fbLine = (c & 1) ? fbGainsR : fbGainsL;
        const crossSrc = hasCoupling ? crossFeedPrev[1 - c] : null;
        const crossDst = hasCoupling ? crossFeedCur[c] : null;

        const pdl = predelayLines[c];
        let pdw = predelayWriteIdx[c];
        const pdLen = predelayLen;

        for (let i = 0; i < frameCount; i++) {
          const input = buf[i];

          let delayed = input;
          if (pdLen > 0) {
            delayed = pdl[pdw];
            pdl[pdw] = input;
            pdw = (pdw + 1) % pdLen;
          }

          for (let l = 0; l < FDN_LINES; l++) {
            tapsScratch[l] = ls[l][wis[l]];
          }

          hadamard4(tapsScratch);

          let wet = 0;
          const crossIn = crossSrc ? crossSrc[i] * CROSS_COUPLING : 0;
          for (let l = 0; l < FDN_LINES; l++) {
            lp[l] += dampAlpha * (tapsScratch[l] - lp[l]);
            lp[l] = flushDenormal(lp[l]);
            const damped = lp[l];
            hp[l] = hpAlpha * (hp[l] + damped - hpv[l]);
            hp[l] = flushDenormal(hp[l]);
            hpv[l] = damped;
            wet += hp[l];
            ls[l][wis[l]] = delayed + hp[l] * fbLine[l] + crossIn / FDN_LINES;
            // Modulo the LOGICAL delay length (audit M1): the physical
            // buffer is sized for the largest type, so the FDN wraps at
            // lengths[l], not at the capacity of the allocation.
            wis[l] = (wis[l] + 1) % lengths[l];
          }
          wet /= FDN_LINES;

          if (crossDst) crossDst[i] = wet;
          buf[i] = input * dryGain + wet * wetGain;
        }
        predelayWriteIdx[c] = pdw;
      }

      if (hasCoupling) {
        const tmp = crossFeedPrev;
        crossFeedPrev = crossFeedCur;
        crossFeedCur = tmp;
      }
    },

    reset() {
      for (const ls of lines) for (const b of ls) b.fill(0);
      for (const wis of writeIdx) for (let l = 0; l < wis.length; l++) wis[l] = 0;
      for (const lp of lpState) for (let l = 0; l < lp.length; l++) lp[l] = 0;
      for (const hp of hpState) for (let l = 0; l < hp.length; l++) hp[l] = 0;
      for (const hpv of hpPrev) for (let l = 0; l < hpv.length; l++) hpv[l] = 0;
      for (const pdl of predelayLines) pdl.fill(0);
      for (let c = 0; c < predelayWriteIdx.length; c++) predelayWriteIdx[c] = 0;
      for (const cf of crossFeedPrev) cf.fill(0);
      for (const cf of crossFeedCur) cf.fill(0);
    },

    getLatencySamples() {
      return 0;
    },

    setParameter(id, value) {
      store.set(id, value);
      if (prepared && (id === "type" || id === "decayMs")) recompute();
      if (prepared && id === "predelayMs") {
        predelayLen = Math.round((clamp(value, 0, 100) / 1000) * sampleRate);
      }
    },
    getParameter(id) {
      return store.get(id);
    },
    getParameters() {
      return store.all();
    },
    loadParameters(p) {
      store.load(p);
      if (prepared) recompute();
    },
  };
}
