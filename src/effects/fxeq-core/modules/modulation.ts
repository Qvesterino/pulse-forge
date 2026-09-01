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
// FXEQ — Modulation module
//
//   0 — Chorus:  3 short LFO-modulated delay taps, slightly detuned
//   1 — Flanger: single modulated delay (0.1–5 ms) with feedback
//   2 — Phaser:  cascaded all-pass filters with LFO-swept corners
//   3 — Doubler: 2 fixed slightly-detuned delay lines (~22 ms)
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import { clamp, hermiteInterp } from "../dsp/mathUtils.js";
import { createLfo } from "../dsp/lfo.js";
import { type BiquadState, createBiquad, setAllPass, resetBiquad } from "../dsp/biquad.js";
import { createParamStore } from "./moduleHelpers.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";

export const MOD_TYPE_ID = "modulation";

const PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "enabled", name: "Enabled", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "type", name: "Type", defaultValue: 0, minValue: 0, maxValue: 3, automatable: false },
  { id: "rate", name: "Rate", defaultValue: 1.0, minValue: 0.05, maxValue: 20, unit: "Hz", logScale: true, automatable: true },
  { id: "depth", name: "Depth", defaultValue: 40, minValue: 0, maxValue: 100, unit: "%", automatable: true },
  { id: "feedback", name: "Feedback", defaultValue: 0.3, minValue: 0, maxValue: 0.9, unit: "%", automatable: true },
  { id: "mix", name: "Mix", defaultValue: 50, minValue: 0, maxValue: 100, unit: "%", automatable: true },
] as const;

// Delay line length is expressed in time, not a fixed number of samples. The
// longest current algorithmic read is ~30 ms; keep headroom for interpolation
// and future presets while preserving the same timing at every sample rate.
const MOD_MAX_DELAY_MS = 40;
const PHASER_STAGES = 6;

export function createModulationModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let sampleRate = 44100;
  let preparedMaxBlockSize = 1;

  // Delay line (per channel) for chorus/flanger/doubler.
  const delayBuf: Float32Array[] = [];
  const writeIdx: number[] = [];
  // Feedback state for flanger (per channel).
  const flangerFb: number[] = [];
  // Phaser feedback state (per channel): the all-pass chain output is
  // fed back into the chain input, scaled by `feedback`.
  const phaserFb: number[] = [];

  const lfo = createLfo(44100, 1, "sine", Math.PI / 2, 1);
  const lfo2 = createLfo(44100, 1.3, "triangle", Math.PI / 4, 1);
  const lfo3 = createLfo(44100, 0.7, "sine", Math.PI, 1);

  // Phaser all-pass stages (per channel): 6 stages.
  const phaserStages: BiquadState[][] = [];

  function allocChannels(channelCount: number): void {
    const delaySamples = Math.max(8, Math.ceil((MOD_MAX_DELAY_MS / 1000) * sampleRate) + 4);
    delayBuf.length = 0;
    writeIdx.length = 0;
    flangerFb.length = 0;
    phaserFb.length = 0;
    phaserStages.length = 0;
    for (let c = 0; c < channelCount; c++) {
      delayBuf.push(new Float32Array(delaySamples));
      writeIdx.push(0);
      flangerFb.push(0);
      phaserFb.push(0);
      const stages: BiquadState[] = [];
      for (let s = 0; s < PHASER_STAGES; s++) {
        stages.push(createBiquad(channelCount));
      }
      phaserStages.push(stages);
    }
  }

  function tunePhaser(centerHz: number): void {
    for (const stages of phaserStages) {
      for (const bq of stages) {
        setAllPass(bq.coeffs, centerHz, 0.7, sampleRate);
      }
    }
  }

  function readDelay(dBuf: Float32Array, wi: number, offset: number): number {
    const len = dBuf.length;
    let rp = wi - offset;
    rp = ((rp % len) + len) % len;
    const i0 = Math.floor(rp);
    const frac = rp - i0;
    return hermiteInterp(
      dBuf[i0],
      dBuf[(i0 + 1) % len],
      dBuf[(i0 + 2) % len],
      dBuf[(i0 + 3) % len],
      frac,
    );
  }

  const PHASER_COEFF_INTERVAL = 32;

  function processPhaser(
    channels: Float32Array[],
    frameCount: number,
    depth: number,
    feedback: number,
    wetGain: number,
    dryGain: number,
  ): void {
    const numCh = channels.length;
    for (let i = 0; i < frameCount; i++) {
      const [l, r] = lfo.read();

      if (i % PHASER_COEFF_INTERVAL === 0) {
        const lfoVal = 0.5 * (l + r);
        const center = 300 + (0.5 + 0.5 * lfoVal) * 3000;
        tunePhaser(center);
      }

      for (let c = 0; c < numCh; c++) {
        const buf = channels[c];
        const input = buf[i];
        // Classic phaser feedback: the previous all-pass chain output is
        // scaled by `feedback` and added to the input before the chain.
        // (The old code added raw input to the wet bus, which was not
        // feedback at all and caused a phase-dependent level boost.)
        let y = input + phaserFb[c] * feedback;
        for (const stage of phaserStages[c]) {
          const z1 = stage.z1[c];
          const z2 = stage.z2[c];
          const { b0, b1, b2, a1, a2 } = stage.coeffs;
          const out = b0 * y + z1;
          stage.z1[c] = b1 * y - a1 * out + z2;
          stage.z2[c] = b2 * y - a2 * out;
          y = out;
        }
        phaserFb[c] = y;
        buf[i] = input * dryGain + y * wetGain * depth + input * (1 - depth) * wetGain;
      }
    }
  }

  return {
    get typeId() {
      return MOD_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sr, channelCount, maxBlockSize) {
      sampleRate = sr;
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      allocChannels(Math.max(1, channelCount));
      lfo.setSampleRate(sampleRate);
      lfo2.setSampleRate(sampleRate);
      lfo3.setSampleRate(sampleRate);
      lfo.setRate(store.get("rate"));
      lfo2.setRate(store.get("rate") * 1.3);
      lfo3.setRate(store.get("rate") * 0.7);
      lfo.reset();
      lfo2.reset();
      lfo3.reset();
      tunePhaser(1000);
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "modulation", delayBuf.length);
      if (frameCount === 0) return;
      if (store.get("enabled") < 0.5) return;

      const type = Math.round(store.get("type"));
      const depth = clamp(store.get("depth"), 0, 100) / 100;
      const feedback = clamp(store.get("feedback"), 0, 0.9);
      const wetGain = clamp(store.get("mix"), 0, 100) / 100;
      const dryGain = 1 - wetGain;

      if (type === 2) {
        processPhaser(channels, frameCount, depth, feedback, wetGain, dryGain);
        return;
      }

      const chorusBase = 0.025 * sampleRate;
      const flangerBase = 0.001 * sampleRate;
      const flangerSpan = 0.004 * sampleRate;
      const doublerOffset = Math.round(0.022 * sampleRate);

      for (let i = 0; i < frameCount; i++) {
        const [l1, r1] = lfo.read();
        const [l2, r2] = lfo2.read();
        const [l3, r3] = lfo3.read();

        for (let c = 0; c < channels.length; c++) {
          const buf = channels[c];
          const dBuf = delayBuf[c];
          let wi = writeIdx[c];
          const input = buf[i];

          let writeVal = input;
          if (type === 1) {
            writeVal = input + flangerFb[c] * feedback;
          }
          dBuf[wi] = writeVal;
          wi = (wi + 1) % dBuf.length;

          let wet = 0;
          if (type === 0) {
            const o1 = c === 0 ? l1 : r1;
            const o2 = c === 0 ? l2 : r2;
            const o3 = c === 0 ? l3 : r3;
            wet =
              readDelay(dBuf, wi, chorusBase + o1 * 0.004 * sampleRate * depth) +
              readDelay(dBuf, wi, chorusBase + 0.001 * sampleRate + o2 * 0.004 * sampleRate * depth) +
              readDelay(dBuf, wi, chorusBase - 0.001 * sampleRate + o3 * 0.004 * sampleRate * depth);
            wet /= 3;
          } else if (type === 1) {
            const lfoVal = c === 0 ? l1 : r1;
            const offset = flangerBase + (0.5 + 0.5 * lfoVal) * flangerSpan * depth;
            wet = readDelay(dBuf, wi, offset);
            flangerFb[c] = wet;
          } else if (type === 3) {
            wet =
              readDelay(dBuf, wi, doublerOffset) +
              readDelay(dBuf, wi, doublerOffset + Math.round(0.004 * sampleRate));
            wet /= 2;
          }

          buf[i] = input * dryGain + wet * wetGain;
          writeIdx[c] = wi;
        }
      }
    },

    reset() {
      for (const b of delayBuf) b.fill(0);
      for (let c = 0; c < writeIdx.length; c++) {
        writeIdx[c] = 0;
        flangerFb[c] = 0;
        phaserFb[c] = 0;
      }
      for (const stages of phaserStages) for (const bq of stages) resetBiquad(bq);
      lfo.reset();
      lfo2.reset();
      lfo3.reset();
    },

    getLatencySamples() {
      return 0;
    },

    setParameter(id, value) {
      store.set(id, value);
      if (prepared && id === "rate") {
        lfo.setRate(store.get("rate"));
        lfo2.setRate(store.get("rate") * 1.3);
        lfo3.setRate(store.get("rate") * 0.7);
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
      if (prepared) {
        lfo.setRate(store.get("rate"));
        lfo2.setRate(store.get("rate") * 1.3);
        lfo3.setRate(store.get("rate") * 0.7);
      }
    },
  };
}
