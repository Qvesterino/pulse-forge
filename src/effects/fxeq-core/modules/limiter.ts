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
// FXEQ — True-peak brickwall limiter
//
// Professional inter-sample-peak (ISP) limiter using 4× polyphase
// FIR oversampling with configurable lookahead. Guarantees that the
// output never exceeds the configured ceiling, even between samples.
//
// Architecture
//   Input → 4× polyphase upsample → lookahead peak detection
//         → gain computation (oversampled domain) → gain smoothing
//         → apply gain → 4× polyphase downsample → Output
//
// The detection and gain application happen in the 4× oversampled
// domain, ensuring inter-sample peaks are contained. A lookahead
// buffer allows the limiter to anticipate upcoming peaks and begin
// gain reduction preemptively.
//
// Three operating modes
//   1. True-peak + lookahead (default):
//      Full ISP limiting. Output delayed by lookaheadMs. Latency
//      is reported via getLatencySamples() so the host can compensate.
//   2. True-peak + lookahead = 0:
//      Oversampled limiting without lookahead. Zero latency, but may
//      not contain all inter-sample peaks at block boundaries.
//   3. Legacy (truePeak = 0):
//      Original sample-peak brickwall using linear-interpolation ISP
//      detection at the input rate. Zero latency. Kept for backward
//      compatibility and latency-critical monitoring paths.
//
// The detection path oversamples 4× using a Kaiser-windowed sinc
// polyphase FIR (90 dB stopband) — the same filter used by the
// metering engine for true-peak measurement. Between consecutive
// 4×-oversampled samples, three linearly interpolated sub-sample
// points are checked for additional peak precision.
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import { clamp, dbToLinear } from "../dsp/mathUtils.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";
import { createParamStore } from "./moduleHelpers.js";
import {
  createPolyphaseOversampler,
  type PolyphaseOversampler,
  type OversampleFactor,
} from "../dsp/oversampler.js";

export const LIMITER_TYPE_ID = "limiter";

/** Oversampling factor for true-peak detection and gain application. */
const OS: OversampleFactor = 4;

/** Maximum lookahead in ms (drives ring-buffer allocation at prepare). */
const MAX_LA_MS = 5;

const PARAM_DEFS: readonly FxEqParamDef[] = [
  {
    id: "enabled",
    name: "Enabled",
    defaultValue: 1,
    minValue: 0,
    maxValue: 1,
    automatable: false,
  },
  {
    id: "ceilDb",
    name: "Ceiling",
    defaultValue: -0.3,
    minValue: -6,
    maxValue: 0,
    unit: "dB",
    automatable: true,
  },
  {
    id: "releaseMs",
    name: "Release",
    defaultValue: 100,
    minValue: 5,
    maxValue: 500,
    unit: "ms",
    automatable: true,
  },
  {
    id: "truePeak",
    name: "True Peak",
    defaultValue: 1,
    minValue: 0,
    maxValue: 1,
    automatable: false,
  },
  {
    id: "lookaheadMs",
    name: "Lookahead",
    defaultValue: 2,
    minValue: 0,
    maxValue: 5,
    unit: "ms",
    automatable: false,
  },
  {
    id: "stereoLink",
    name: "Stereo Link",
    defaultValue: 1,
    minValue: 0,
    maxValue: 1,
    automatable: false,
  },
] as const;

// ── Per-channel state ──────────────────────────────────────

interface Chan {
  /** 4× polyphase oversampler. */
  os: PolyphaseOversampler;
  /** Gain envelope (at input rate for legacy, oversampled rate for TP). */
  env: number;
  /** Circular lookahead buffer holding oversampled samples. */
  ring: Float32Array;
  /** Write position in ring buffer. */
  wp: number;
  /** Valid sample count in ring buffer (capped at ringCap). */
  fill: number;
  /** Previous input sample (legacy ISP detection only). */
  prev: number;
}

// ── Factory ────────────────────────────────────────────────

export function createLimiterModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let sampleRate = 44100;
  let maxBs = 0;

  /** Current lookahead expressed in oversampled samples. */
  let laOvs = 0;
  /** Ring buffer capacity (oversampled samples). Sized for MAX_LA_MS. */
  let ringCap = 0;
  /** Per-channel state. */
  const ch: Chan[] = [];

  // ── Internal helpers ──────────────────────────────────────

  function initChannels(n: number): void {
    ch.length = 0;
    for (let i = 0; i < n; i++) {
      ch.push({
        os: createPolyphaseOversampler(),
        env: 1,
        ring: new Float32Array(0),
        wp: 0,
        fill: 0,
        prev: 0,
      });
    }
  }

  // ── Legacy sample-peak path (zero latency) ────────────────

  function processLegacy(channels: Float32Array[], n: number, ceil: number): void {
    const relMs = clamp(store.get("releaseMs"), 5, 500);
    const rc = Math.exp(-1 / ((relMs / 1000) * sampleRate));
    const linked = store.get("stereoLink") >= 0.5 && channels.length > 1;
    const numCh = channels.length;

    if (!linked) {
      for (let c = 0; c < numCh; c++) {
        const buf = channels[c];
        let env = ch[c].env;
        let prev = ch[c].prev;

        for (let i = 0; i < n; i++) {
          const x = buf[i];

          let peak = x < 0 ? -x : x;
          for (let k = 1; k <= 3; k++) {
            const t = k / 4;
            const y = prev + (x - prev) * t;
            const a = y < 0 ? -y : y;
            if (a > peak) peak = a;
          }

          let tgt = 1;
          if (peak * env > ceil && peak > 1e-9) {
            tgt = ceil / peak;
            if (tgt > env) tgt = env;
          }

          if (tgt < env) {
            env = tgt;
          } else {
            env = env * rc + tgt * (1 - rc);
          }

          buf[i] = x * env;
          prev = x;
        }

        ch[c].env = env;
        ch[c].prev = prev;
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      let minTgt = 1;

      for (let c = 0; c < numCh; c++) {
        const x = channels[c][i];
        const prev = ch[c].prev;

        let peak = x < 0 ? -x : x;
        for (let k = 1; k <= 3; k++) {
          const t = k / 4;
          const y = prev + (x - prev) * t;
          const a = y < 0 ? -y : y;
          if (a > peak) peak = a;
        }

        let tgt = 1;
        if (peak * ch[c].env > ceil && peak > 1e-9) {
          tgt = ceil / peak;
          if (tgt > ch[c].env) tgt = ch[c].env;
        }

        if (tgt < minTgt) minTgt = tgt;
        ch[c].prev = x;
      }

      for (let c = 0; c < numCh; c++) {
        let env = ch[c].env;
        if (minTgt < env) {
          env = minTgt;
        } else {
          env = env * rc + minTgt * (1 - rc);
        }
        ch[c].env = env;
        channels[c][i] = channels[c][i] * env;
      }
    }
  }

  // ── True-peak oversampled path ────────────────────────────
  //
  // Uses a deque-based sliding window maximum for O(N) peak detection
  // instead of the naive O(N·LA) brute-force scan.
  //
  // Key insight: the ring buffer spans multiple blocks, so we compute
  // the effective peak (including ISP) for a window that extends into
  // the previous block's data. The deque then finds the sliding window
  // maximum in O(1) amortized per sample.
  //
  // Pre-allocated scratch buffers.
  let epScratch = new Float32Array(0);
  let dequeIdx = new Int32Array(0);
  let dequeVal = new Float32Array(0);
  const linkedEnvScratch: Float32Array[] = [];

  function processTruePeak(channels: Float32Array[], n: number, ceil: number): void {
    const relMs = clamp(store.get("releaseMs"), 5, 500);
    const ovsRate = sampleRate * OS;
    const rc = Math.exp(-1 / ((relMs / 1000) * ovsRate));
    const upLen = n * OS;
    const linked = store.get("stereoLink") >= 0.5 && channels.length > 1;

    // Effective lookahead: ramp up as the ring buffer fills.
    const effLA = Math.min(laOvs, ch.length > 0 ? ch[0].fill : 0);

    // Total ep positions: effLA (from previous block) + upLen (current block).
    const totalEp = effLA + upLen;

    // Ensure scratch buffers are large enough.
    if (epScratch.length < totalEp) {
      epScratch = new Float32Array(totalEp);
      dequeIdx = new Int32Array(totalEp);
      dequeVal = new Float32Array(totalEp);
    }

    if (linked) {
      processTruePeakLinked(channels, n, ceil, rc, upLen, effLA, totalEp);
      return;
    }

    for (let c = 0; c < channels.length; c++) {
      const s = ch[c];

      const up = s.os.upsample(channels[c]);

      for (let i = 0; i < upLen; i++) {
        s.ring[(s.wp + i) % ringCap] = up[i];
      }
      s.wp = (s.wp + upLen) % ringCap;
      s.fill = Math.min(s.fill + upLen, ringCap);

      const ringStart = (((s.wp - totalEp) % ringCap) + ringCap) % ringCap;
      for (let i = 0; i < totalEp; i++) {
        const ri = (ringStart + i) % ringCap;
        const abs = s.ring[ri] < 0 ? -s.ring[ri] : s.ring[ri];
        let ep = abs;
        if (i < totalEp - 1) {
          const ni = (ri + 1) % ringCap;
          const a = s.ring[ri];
          const b = s.ring[ni];
          const d = b - a;
          let y = a + d * 0.25;
          let ay = y < 0 ? -y : y;
          if (ay > ep) ep = ay;
          y = a + d * 0.5;
          ay = y < 0 ? -y : y;
          if (ay > ep) ep = ay;
          y = a + d * 0.75;
          ay = y < 0 ? -y : y;
          if (ay > ep) ep = ay;
        }
        epScratch[i] = ep;
      }

      let dqHead = 0;
      let dqTail = 0;
      let outIdx = 0;

      for (let j = 0; j < totalEp; j++) {
        while (dqTail > dqHead && epScratch[j] >= epScratch[dequeIdx[dqTail - 1]]) {
          dqTail--;
        }
        dequeIdx[dqTail] = j;
        dequeVal[dqTail] = epScratch[j];
        dqTail++;

        while (dqHead < dqTail && dequeIdx[dqHead] < j - effLA) {
          dqHead++;
        }

        if (j >= effLA) {
          const peak = dequeVal[dqHead];

          let tgt = 1;
          if (peak > ceil && peak > 1e-9) tgt = ceil / peak;

          if (tgt < s.env) {
            s.env = tgt;
          } else {
            s.env = s.env * rc + tgt * (1 - rc);
          }

          const op = (((s.wp - upLen + outIdx - effLA) % ringCap) + ringCap) % ringCap;

          up[outIdx] = s.ring[op] * s.env;
          outIdx++;
        }
      }

      const down = s.os.downsample(up);
      const copyLen = Math.min(n, down.length);
      for (let i = 0; i < copyLen; i++) channels[c][i] = down[i];
      for (let i = copyLen; i < n; i++) channels[c][i] = 0;
    }
  }

  function processTruePeakLinked(
    channels: Float32Array[],
    n: number,
    ceil: number,
    rc: number,
    upLen: number,
    effLA: number,
    totalEp: number,
  ): void {
    const numCh = channels.length;

    while (linkedEnvScratch.length < numCh) {
      linkedEnvScratch.push(new Float32Array(0));
    }
    for (let c = 0; c < numCh; c++) {
      if (linkedEnvScratch[c].length < upLen) {
        linkedEnvScratch[c] = new Float32Array(upLen);
      }
    }

    const upBuffers: Float32Array[] = [];

    for (let c = 0; c < numCh; c++) {
      const s = ch[c];
      const up = s.os.upsample(channels[c]);
      upBuffers.push(up);

      for (let i = 0; i < upLen; i++) {
        s.ring[(s.wp + i) % ringCap] = up[i];
      }
      s.wp = (s.wp + upLen) % ringCap;
      s.fill = Math.min(s.fill + upLen, ringCap);

      const ringStart = (((s.wp - totalEp) % ringCap) + ringCap) % ringCap;
      for (let i = 0; i < totalEp; i++) {
        const ri = (ringStart + i) % ringCap;
        const abs = s.ring[ri] < 0 ? -s.ring[ri] : s.ring[ri];
        let ep = abs;
        if (i < totalEp - 1) {
          const ni = (ri + 1) % ringCap;
          const a = s.ring[ri];
          const b = s.ring[ni];
          const d = b - a;
          let y = a + d * 0.25;
          let ay = y < 0 ? -y : y;
          if (ay > ep) ep = ay;
          y = a + d * 0.5;
          ay = y < 0 ? -y : y;
          if (ay > ep) ep = ay;
          y = a + d * 0.75;
          ay = y < 0 ? -y : y;
          if (ay > ep) ep = ay;
        }
        epScratch[i] = ep;
      }

      let dqHead = 0;
      let dqTail = 0;
      let outIdx = 0;

      for (let j = 0; j < totalEp; j++) {
        while (dqTail > dqHead && epScratch[j] >= epScratch[dequeIdx[dqTail - 1]]) {
          dqTail--;
        }
        dequeIdx[dqTail] = j;
        dequeVal[dqTail] = epScratch[j];
        dqTail++;

        while (dqHead < dqTail && dequeIdx[dqHead] < j - effLA) {
          dqHead++;
        }

        if (j >= effLA) {
          const peak = dequeVal[dqHead];

          let tgt = 1;
          if (peak > ceil && peak > 1e-9) tgt = ceil / peak;

          if (tgt < s.env) {
            s.env = tgt;
          } else {
            s.env = s.env * rc + tgt * (1 - rc);
          }

          linkedEnvScratch[c][outIdx] = s.env;
          outIdx++;
        }
      }
    }

    let lastMinEnv = 1;
    for (let i = 0; i < upLen; i++) {
      let minEnv = linkedEnvScratch[0][i];
      for (let c = 1; c < numCh; c++) {
        if (linkedEnvScratch[c][i] < minEnv) minEnv = linkedEnvScratch[c][i];
      }
      for (let c = 0; c < numCh; c++) {
        const s = ch[c];
        const op = (((s.wp - upLen + i - effLA) % ringCap) + ringCap) % ringCap;
        upBuffers[c][i] = s.ring[op] * minEnv;
      }
      lastMinEnv = minEnv;
    }

    // In linked mode the gain actually applied to every channel is
    // minEnv (the shared envelope), not the per-channel s.env. Storing
    // s.env here caused getGainReductionDb() to read the looser
    // per-channel envelope and under-report the audible reduction
    // (Audit #C3). Use the *last* minEnv — it represents the most
    // recent applied gain.
    for (let c = 0; c < numCh; c++) {
      const s = ch[c];
      s.env = lastMinEnv;
      const down = s.os.downsample(upBuffers[c]);
      const copyLen = Math.min(n, down.length);
      for (let i = 0; i < copyLen; i++) channels[c][i] = down[i];
      for (let i = copyLen; i < n; i++) channels[c][i] = 0;
    }
  }

  // ── Public interface ──────────────────────────────────────

  return {
    get typeId() {
      return LIMITER_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sampleRate_, channelCount, maxBlockSize) {
      sampleRate = clamp(sampleRate_, 8000, 192000);
      maxBs = Math.max(1, maxBlockSize);
      initChannels(Math.max(1, channelCount));

      // Size ring buffer for maximum possible lookahead so that
      // parameter changes never require reallocation.
      const maxLaOvs = Math.round((MAX_LA_MS / 1000) * sampleRate) * OS;
      ringCap = maxLaOvs + OS * maxBs;

      for (const s of ch) {
        s.os.prepare(sampleRate, OS, maxBs);
        s.ring = new Float32Array(ringCap);
      }
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, maxBs, "limiter", ch.length);
      if (frameCount === 0) return;
      if (store.get("enabled") < 0.5) return;

      const ceil = dbToLinear(store.get("ceilDb"));
      const useTP = store.get("truePeak") >= 0.5;

      // Recompute lookahead from parameter (may change between blocks).
      const laMs = clamp(store.get("lookaheadMs"), 0, 5);
      laOvs = Math.round((laMs / 1000) * sampleRate) * OS;

      const n = frameCount;

      if (useTP) {
        processTruePeak(channels, n, ceil);
      } else {
        processLegacy(channels, n, ceil);
      }
    },

    reset() {
      for (const s of ch) {
        s.env = 1;
        s.prev = 0;
        s.wp = 0;
        s.fill = 0;
        s.ring.fill(0);
        s.os.reset();
      }
    },

    getLatencySamples() {
      if (store.get("enabled") < 0.5) return 0;
      if (store.get("truePeak") < 0.5) return 0;
      // Oversampler group delay + lookahead delay (input-rate samples).
      const laMs = clamp(store.get("lookaheadMs"), 0, 5);
      const laSamples = Math.round((laMs / 1000) * sampleRate);
      const osLatency = ch.length > 0 ? ch[0].os.latencySamples : 0;
      return osLatency + laSamples;
    },

    getGainReductionDb() {
      if (ch.length === 0) return 0;
      let minEnv = ch[0].env;
      for (let c = 1; c < ch.length; c++) {
        if (ch[c].env < minEnv) minEnv = ch[c].env;
      }
      if (minEnv >= 1) return 0;
      return -20 * Math.log10(Math.max(minEnv, 1e-6));
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
