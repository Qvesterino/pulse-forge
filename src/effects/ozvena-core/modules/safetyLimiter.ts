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
// Ozvena — True-peak safety limiter
//
// Always-on brickwall safety limiter at the very end of the signal
// chain. Guarantees the output never exceeds the ceiling (default
// -0.3 dBFS true peak), even between samples, satisfying the
// "never produce an intersample peak above -0.3 dBFS" contract.
//
// Architecture (mirrors the battle-tested FXEQ limiter):
//   Input → 4× polyphase upsample → lookahead peak detection
//         → gain computation (oversampled domain) → gain smoothing
//         → apply gain → 4× polyphase downsample → Output
//
// Detection and gain application happen in the 4× oversampled domain
// so inter-sample peaks are contained. A short lookahead lets the
// limiter anticipate peaks and start gain reduction preemptively.
// Stereo-linked: the loudest channel drives a shared gain so the
// stereo image is preserved.
// ═══════════════════════════════════════════════════════════

import { clamp, dbToLinear } from "../dsp/math.js";
import {
  createPolyphaseOversampler,
  type PolyphaseOversampler,
  type OversampleFactor,
} from "../dsp/oversampler.js";

const OS_MAX: OversampleFactor = 8;
const MAX_LA_MS = 5;
const RELEASE_MS = 100;
const LOOKAHEAD_MS = 2;
const DEFAULT_CEIL_DB = -0.3;

export interface SafetyLimiter {
  prepare(sampleRate: number, channelCount: number, maxBlockSize: number, osFactor?: OversampleFactor): void;
  process(channels: Float32Array[], frameCount: number): void;
  reset(): void;
  /** Total latency introduced (oversampler group delay + lookahead). */
  getLatencySamples(): number;
  /** Current gain reduction in dB (0 = not limiting). */
  getGainReductionDb(): number;
  /** Set the output ceiling in dBFS (default -0.3). */
  setCeilingDb(db: number): void;
}

interface Chan {
  os: PolyphaseOversampler;
  env: number;
  ring: Float32Array;
  wp: number;
  fill: number;
}

export function createSafetyLimiter(): SafetyLimiter {
  let prepared = false;
  let sampleRate = 48000;
  let ceilDb = DEFAULT_CEIL_DB;
  let os: OversampleFactor = 4;

  let laOvs = 0;
  let ringCap = 0;
  const ch: Chan[] = [];

  let epScratch = new Float32Array(0);
  let dequeIdx = new Int32Array(0);
  let dequeVal = new Float32Array(0);
  let linkedEnvScratch: Float32Array[] = [];
  // Reused per-block pointer array (no JS array allocation per block).
  let upBuffers: Float32Array[] = [];

  function initChannels(n: number): void {
    ch.length = 0;
    for (let i = 0; i < n; i++) {
      ch.push({ os: createPolyphaseOversampler(), env: 1, ring: new Float32Array(0), wp: 0, fill: 0 });
    }
  }

  /** Fill epScratch[0..totalEp) with the effective (inter-sample) peak per position. */
  function computeEffectivePeaks(s: Chan, totalEp: number): void {
    const ringStart = ((s.wp - totalEp) % ringCap + ringCap) % ringCap;
    for (let i = 0; i < totalEp; i++) {
      const ri = (ringStart + i) % ringCap;
      const a = s.ring[ri];
      const abs = a < 0 ? -a : a;
      let ep = abs;
      if (i < totalEp - 1) {
        const ni = (ri + 1) % ringCap;
        const b = s.ring[ni];
        const d = b - a;
        let y = a + d * 0.25; let ay = y < 0 ? -y : y; if (ay > ep) ep = ay;
        y = a + d * 0.5;  ay = y < 0 ? -y : y; if (ay > ep) ep = ay;
        y = a + d * 0.75; ay = y < 0 ? -y : y; if (ay > ep) ep = ay;
      }
      epScratch[i] = ep;
    }
  }

  function processLinked(channels: Float32Array[], n: number, ceil: number, rc: number, upLen: number, effLA: number, totalEp: number): void {
    const numCh = channels.length;
    while (linkedEnvScratch.length < numCh) linkedEnvScratch.push(new Float32Array(0));
    for (let c = 0; c < numCh; c++) {
      if (linkedEnvScratch[c].length < upLen) linkedEnvScratch[c] = new Float32Array(upLen);
    }
    upBuffers.length = numCh;

    for (let c = 0; c < numCh; c++) {
      const s = ch[c];
      // Explicit n: host channel buffers may be longer than the block, and
      // stale samples past frameCount must not feed the filter state.
      const up = s.os.upsample(channels[c], n);
      upBuffers[c] = up;
      for (let i = 0; i < upLen; i++) s.ring[(s.wp + i) % ringCap] = up[i];
      s.wp = (s.wp + upLen) % ringCap;
      s.fill = Math.min(s.fill + upLen, ringCap);

      computeEffectivePeaks(s, totalEp);

      let dqHead = 0, dqTail = 0, outIdx = 0;
      for (let j = 0; j < totalEp; j++) {
        while (dqTail > dqHead && epScratch[j] >= epScratch[dequeIdx[dqTail - 1]]) dqTail--;
        dequeIdx[dqTail] = j; dequeVal[dqTail] = epScratch[j]; dqTail++;
        while (dqHead < dqTail && dequeIdx[dqHead] < j - effLA) dqHead++;
        if (j >= effLA) {
          const peak = dequeVal[dqHead];
          let tgt = 1;
          if (peak > ceil && peak > 1e-9) tgt = ceil / peak;
          s.env = tgt < s.env ? tgt : s.env * rc + tgt * (1 - rc);
          linkedEnvScratch[c][outIdx++] = s.env;
        }
      }
    }

    for (let i = 0; i < upLen; i++) {
      let minEnv = linkedEnvScratch[0][i];
      for (let c = 1; c < numCh; c++) if (linkedEnvScratch[c][i] < minEnv) minEnv = linkedEnvScratch[c][i];
      for (let c = 0; c < numCh; c++) {
        const s = ch[c];
        const op = ((s.wp - upLen + i - effLA) % ringCap + ringCap) % ringCap;
        upBuffers[c][i] = s.ring[op] * minEnv;
      }
    }

        for (let c = 0; c < numCh; c++) {
          const s = ch[c];
          s.env = linkedEnvScratch[c][upLen - 1];
          const down = s.os.downsample(upBuffers[c], upLen);
          const copyLen = Math.min(n, down.length);
          for (let i = 0; i < copyLen; i++) channels[c][i] = down[i];
          for (let i = copyLen; i < n; i++) channels[c][i] = 0;
        }
      }

  function processUnlinked(channels: Float32Array[], n: number, ceil: number, rc: number, upLen: number, effLA: number, totalEp: number): void {
    for (let c = 0; c < channels.length; c++) {
      const s = ch[c];
      const up = s.os.upsample(channels[c], n);
      for (let i = 0; i < upLen; i++) s.ring[(s.wp + i) % ringCap] = up[i];
      s.wp = (s.wp + upLen) % ringCap;
      s.fill = Math.min(s.fill + upLen, ringCap);

      computeEffectivePeaks(s, totalEp);

      let dqHead = 0, dqTail = 0, outIdx = 0;
      for (let j = 0; j < totalEp; j++) {
        while (dqTail > dqHead && epScratch[j] >= epScratch[dequeIdx[dqTail - 1]]) dqTail--;
        dequeIdx[dqTail] = j; dequeVal[dqTail] = epScratch[j]; dqTail++;
        while (dqHead < dqTail && dequeIdx[dqHead] < j - effLA) dqHead++;
        if (j >= effLA) {
          const peak = dequeVal[dqHead];
          let tgt = 1;
          if (peak > ceil && peak > 1e-9) tgt = ceil / peak;
          s.env = tgt < s.env ? tgt : s.env * rc + tgt * (1 - rc);
          const op = ((s.wp - upLen + outIdx - effLA) % ringCap + ringCap) % ringCap;
          up[outIdx++] = s.ring[op] * s.env;
        }
      }

      const down = s.os.downsample(up, upLen);
      const copyLen = Math.min(n, down.length);
      for (let i = 0; i < copyLen; i++) channels[0][i] = down[i];
      for (let i = copyLen; i < n; i++) channels[0][i] = 0;
    }
  }

  return {
    prepare(sr, channelCount, maxBlockSize, osFactor = 4) {
      sampleRate = clamp(sr, 8000, 192000);
      os = osFactor;
      const maxBs = Math.max(1, maxBlockSize);
      initChannels(Math.max(1, channelCount));
      // Ring buffer sized for the maximum factor so a quality change
      // never overflows it between re-prepares.
      const maxLaOvs = Math.round((MAX_LA_MS / 1000) * sampleRate) * OS_MAX;
      ringCap = maxLaOvs + OS_MAX * maxBs;
      for (const s of ch) {
        s.os.prepare(sampleRate, os);
        s.ring = new Float32Array(ringCap);
      }
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared || frameCount <= 0 || ch.length === 0) return;
      const ceil = dbToLinear(ceilDb);
      const ovsRate = sampleRate * os;
      const rc = Math.exp(-1 / ((RELEASE_MS / 1000) * ovsRate));
      const upLen = frameCount * os;
      laOvs = Math.round((LOOKAHEAD_MS / 1000) * sampleRate) * os;
      const effLA = Math.min(laOvs, ch[0].fill);
      const totalEp = effLA + upLen;

      if (epScratch.length < totalEp) {
        epScratch = new Float32Array(totalEp);
        dequeIdx = new Int32Array(totalEp);
        dequeVal = new Float32Array(totalEp);
      }

      if (channels.length > 1) {
        processLinked(channels, frameCount, ceil, rc, upLen, effLA, totalEp);
      } else {
        processUnlinked(channels, frameCount, ceil, rc, upLen, effLA, totalEp);
      }
    },

    reset() {
      for (const s of ch) {
        s.env = 1; s.wp = 0; s.fill = 0;
        s.ring.fill(0);
        s.os.reset();
      }
    },

    getLatencySamples() {
      const laSamples = Math.round((LOOKAHEAD_MS / 1000) * sampleRate);
      const osLatency = ch.length > 0 ? ch[0].os.latencySamples : 0;
      return osLatency + laSamples;
    },

    getGainReductionDb() {
      if (ch.length === 0) return 0;
      let minEnv = ch[0].env;
      for (let c = 1; c < ch.length; c++) if (ch[c].env < minEnv) minEnv = ch[c].env;
      if (minEnv >= 1) return 0;
      return -20 * Math.log10(Math.max(minEnv, 1e-6));
    },

    setCeilingDb(db) {
      ceilDb = clamp(db, -6, 0);
    },
  };
}
