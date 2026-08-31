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
// FXEQ — Delay module
//
// 4 algorithms, each a feedback delay with a damping LPF in the loop:
//   0 — Digital:    clean interpolated delay line
//   1 — Tape:       delay + pitch wobble + extra HF loss per repeat
//   2 — Ping-Pong:  feedback crosses L↔R for bouncing echoes
//   3 — Analog:     dark bucket-brigade-style, increasing darkening
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import { clamp, hermiteInterp, onePoleLpCoef } from "../dsp/mathUtils.js";
import { createLfo } from "../dsp/lfo.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";
import { createParamStore } from "./moduleHelpers.js";

export const DELAY_TYPE_ID = "delay";

const MAX_DELAY_MS = 2000;

const PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "enabled", name: "Enabled", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "type", name: "Type", defaultValue: 0, minValue: 0, maxValue: 3, automatable: false },
  {
    id: "timeMs",
    name: "Delay Time",
    defaultValue: 250,
    minValue: 1,
    maxValue: MAX_DELAY_MS,
    unit: "ms",
    logScale: true,
    automatable: true,
  },
  {
    id: "feedback",
    name: "Feedback",
    defaultValue: 0.3,
    minValue: 0,
    maxValue: 0.92,
    unit: "%",
    automatable: true,
  },
  {
    id: "mix",
    name: "Mix",
    defaultValue: 30,
    minValue: 0,
    maxValue: 100,
    unit: "%",
    automatable: true,
  },
  {
    id: "dampHz",
    name: "Damping",
    defaultValue: 4000,
    minValue: 200,
    maxValue: 20000,
    unit: "Hz",
    logScale: true,
    automatable: true,
  },
] as const;

export function createDelayModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let sampleRate = 44100;
  let preparedMaxBlockSize = 1;

  let delayBuf: Float32Array[] = [];
  let writeIdx: number[] = [];
  let delaySamples = 0;
  // Damping one-pole state (per channel).
  let dampPrev: number[] = [];
  let dampAlpha = 1;
  // Block-start write positions (audit M5: the ping-pong cross-read
  // needs a coherent per-sample reference for both channels, but
  // writeIdx is updated per channel after its sample loop).
  let blockStartIdx: number[] = [];
  // Tape wobble LFO.
  const wobbleLfo = createLfo(44100, 0.5, "sine", 0, 1);
  // Pre-computed wobble values per sample, one slot per channel, so the LFO
  // advances exactly once per sample (not once per channel).
  let wobbleLfoBufL: Float32Array = new Float32Array(0);
  let wobbleLfoBufR: Float32Array = new Float32Array(0);

  function allocChannels(channelCount: number, maxBlockSize: number): void {
    const len = Math.ceil((MAX_DELAY_MS / 1000) * sampleRate) + maxBlockSize + 8;
    delayBuf = [];
    writeIdx = [];
    dampPrev = [];
    blockStartIdx = [];
    wobbleLfoBufL = new Float32Array(maxBlockSize);
    wobbleLfoBufR = new Float32Array(maxBlockSize);
    for (let c = 0; c < channelCount; c++) {
      delayBuf.push(new Float32Array(len));
      writeIdx.push(0);
      dampPrev.push(0);
      blockStartIdx.push(0);
    }
  }

  function recompute(): void {
    delaySamples = Math.max(1, Math.round((store.get("timeMs") / 1000) * sampleRate));
    dampAlpha = onePoleLpCoef(clamp(store.get("dampHz"), 200, 20000), sampleRate);
  }

  return {
    get typeId() {
      return DELAY_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sr, channelCount, maxBlockSize) {
      sampleRate = sr;
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      allocChannels(Math.max(1, channelCount), maxBlockSize);
      wobbleLfo.setSampleRate(sampleRate);
      wobbleLfo.setRate(0.5);
      wobbleLfo.reset();
      recompute();
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "delay", delayBuf.length);
      if (frameCount === 0) return;
      if (store.get("enabled") < 0.5) return;

      const type = Math.round(store.get("type"));
      const feedback = clamp(store.get("feedback"), 0, 0.92);
      const wetGain = clamp(store.get("mix"), 0, 100) / 100;
      const bufLen = delayBuf[0].length;

      // Pre-compute wobble LFO values once per sample for tape mode (type 1).
      // Reading inside the per-channel loop would double-advance the phase
      // in stereo, doubling the apparent modulation rate.
      if (type === 1) {
        for (let i = 0; i < frameCount; i++) {
          const [l, r] = wobbleLfo.read();
          wobbleLfoBufL[i] = l;
          wobbleLfoBufR[i] = r;
        }
      }

      // Snapshot block-start write heads for the ping-pong cross-read
      // (audit M5). writeIdx mutates per channel as blocks complete, so
      // both channels must derive their cross-taps from the same origin.
      for (let c = 0; c < channels.length; c++) blockStartIdx[c] = writeIdx[c];

      for (let c = 0; c < channels.length; c++) {
        const buf = channels[c];
        const dBuf = delayBuf[c];
        let wi = writeIdx[c];
        let dp = dampPrev[c];

        for (let i = 0; i < frameCount; i++) {
          const input = buf[i];

          // Read position (modulated for tape wobble).
          let readOffset = delaySamples;
          if (type === 1) {
            const wob = c === 0 ? wobbleLfoBufL[i] : wobbleLfoBufR[i];
            readOffset = delaySamples + wob * 12; // ±12 samples wobble
          }
          let readPos = wi - readOffset;
          // Wrap and interpolate.
          readPos = ((readPos % bufLen) + bufLen) % bufLen;
          const i0 = Math.floor(readPos);
          const frac = readPos - i0;
          const s0 = dBuf[i0];
          const s1 = dBuf[(i0 + 1) % bufLen];
          const s2 = dBuf[(i0 + 2) % bufLen];
          const s3 = dBuf[(i0 + 3) % bufLen];
          const delayed = hermiteInterp(s0, s1, s2, s3, frac);

          // Ping-pong: cross-feedback from the OTHER channel's write head
          // at the same in-block sample position. `writeIdx[other]` only
          // updates at the end of a block, so reading it directly froze
          // the feedback source for the whole block (audit M5) and made
          // the bounce step at block rate. Advancing by `i` reconstructs
          // the live head position: for the channel that already ran it
          // is where its head was at sample i; for the channel that runs
          // later it is where its head WILL be at sample i — both read
          // `readOffset` samples behind a coherent live head.
          let fbSource = delayed;
          if (type === 2 && channels.length > 1) {
            const other = (c + 1) % channels.length;
            let rp = blockStartIdx[other] + i - readOffset;
            rp = ((rp % bufLen) + bufLen) % bufLen;
            const oi = Math.floor(rp);
            const ofrac = rp - oi;
            const o0 = delayBuf[other][oi];
            const o1 = delayBuf[other][(oi + 1) % bufLen];
            fbSource = o0 + (o1 - o0) * ofrac;
          }

          // Damping LPF on the feedback path.
          // Analog type darkens more per repeat.
          const dark = type === 3 ? 0.5 : 1;
          dp += dampAlpha * dark * (fbSource - dp);
          const damped = dp;

          // Write input + feedback into the delay line.
          dBuf[wi] = input + damped * feedback;
          wi = (wi + 1) % bufLen;

          // Output: dry + wet delayed.
          buf[i] = input * (1 - wetGain) + delayed * wetGain;
        }

        writeIdx[c] = wi;
        dampPrev[c] = dp;
      }
    },

    reset() {
      for (const b of delayBuf) b.fill(0);
      for (let c = 0; c < writeIdx.length; c++) {
        writeIdx[c] = 0;
        dampPrev[c] = 0;
      }
      wobbleLfo.reset();
    },

    getLatencySamples() {
      return 0;
    },

    setParameter(id, value) {
      store.set(id, value);
      if (prepared && (id === "timeMs" || id === "dampHz")) recompute();
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
