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
 *
 * LOCAL HARDENING (2026-09, Pulse Forge audit): prepare() now builds the
 * channel state for ALL oversample factors eagerly and setOversampleFactor()
 * switches between them allocation-free — a quality change mid-render used
 * to re-prepare the whole limiter on the audio thread (~0.5 MB of ring
 * allocation + zeroing, click from the envelope reset). Regression
 * coverage: tests/ozvena-hardening.test.ts (quality cycling).
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

import { clamp, dbToLinear, nextPow2 } from "../dsp/math.js";
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
  /**
   * Switch the oversampling factor WITHOUT reallocating: every supported
   * factor's channel state is built in prepare(), so a quality change is a
   * pure pointer swap plus an envelope carry-over. The processor calls this
   * from the realtime path on quality changes; calling prepare() there
   * instead would allocate and zero ~0.5 MB of rings on the audio thread.
   */
  setOversampleFactor(factor: OversampleFactor): void;
}

interface Chan {
  os: PolyphaseOversampler;
  env: number;
  ring: Float32Array;
  wp: number;
  fill: number;
}

const OS_FACTORS: readonly OversampleFactor[] = [1, 2, 4, 8];

export function createSafetyLimiter(): SafetyLimiter {
  let prepared = false;
  let sampleRate = 48000;
  let ceilDb = DEFAULT_CEIL_DB;
  let os: OversampleFactor = 4;

  let laOvs = 0;
  // Power-of-two ring capacity + wrap mask — the peak scan touches every
  // ring position each block, so `% ringCap` wraps are hot-path costs.
  let ringCap = 0;
  let ringMask = 0;
  // ACTIVE channel set (pointer into chByFactor — reassigned by
  // setOversampleFactor, never mutated there).
  let ch: Chan[] = [];
  // One prepared channel set per oversample factor, built eagerly in
  // prepare() so quality changes are allocation-free (LOCAL HARDENING).
  const chByFactor: Partial<Record<OversampleFactor, Chan[]>> = {};

  let epScratch = new Float32Array(0);
  let dequeIdx = new Int32Array(0);
  let dequeVal = new Float32Array(0);
  let linkedEnvScratch: Float32Array[] = [];
  // Reused per-block pointer array (no JS array allocation per block).
  let upBuffers: Float32Array[] = [];

  /** Build a fresh channel set for `factor` (kernels depend on sr+factor). */
  function buildChannels(n: number, factor: OversampleFactor): Chan[] {
    const set: Chan[] = [];
    for (let i = 0; i < n; i++) {
      const c: Chan = { os: createPolyphaseOversampler(), env: 1, ring: new Float32Array(ringCap), wp: 0, fill: 0 };
      c.os.prepare(sampleRate, factor);
      set.push(c);
    }
    return set;
  }

  /** Fill epScratch[0..totalEp) with the effective (inter-sample) peak per position. */
  function computeEffectivePeaks(s: Chan, totalEp: number): void {
    const ringStart = (s.wp - totalEp) & ringMask;
    for (let i = 0; i < totalEp; i++) {
      const ri = (ringStart + i) & ringMask;
      const a = s.ring[ri];
      const abs = a < 0 ? -a : a;
      let ep = abs;
      if (i < totalEp - 1) {
        const ni = (ri + 1) & ringMask;
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
      for (let i = 0; i < upLen; i++) s.ring[(s.wp + i) & ringMask] = up[i];
      s.wp = (s.wp + upLen) & ringMask;
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
        const op = (s.wp - upLen + i - effLA) & ringMask;
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
      for (let i = 0; i < upLen; i++) s.ring[(s.wp + i) & ringMask] = up[i];
      s.wp = (s.wp + upLen) & ringMask;
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
          const op = (s.wp - upLen + outIdx - effLA) & ringMask;
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
      // Ring buffer sized for the maximum factor so a quality change
      // never overflows it between re-prepares. Power-of-two capacity
      // lets the wrap be a mask instead of `%`.
      const maxLaOvs = Math.round((MAX_LA_MS / 1000) * sampleRate) * OS_MAX;
      ringCap = nextPow2(maxLaOvs + OS_MAX * maxBs);
      ringMask = ringCap - 1;
      // Build a channel set for EVERY supported factor (LOCAL HARDENING):
      // allocation happens only here (constructor/reset), never on a
      // quality change mid-render. At the worklet's 128-frame block this
      // costs ~4×32 KB of rings at 48 kHz — noise next to the delay lines.
      const cc = Math.max(1, channelCount);
      for (const f of OS_FACTORS) {
        const set = buildChannels(cc, f);
        chByFactor[f] = set;
      }
      ch = chByFactor[os] as Chan[];
      prepared = true;
    },

    setOversampleFactor(factor) {
      if (!prepared) return;
      if (factor !== 1 && factor !== 2 && factor !== 4 && factor !== 8) return;
      if (factor === os) return;
      const nextSet = chByFactor[factor];
      if (!nextSet) return;
      // Carry the gain envelope across the switch: while the bus was
      // limiting, a reset env=1 would be an instantaneous gain jump (an
      // audible click on every quality change).
      for (let c = 0; c < ch.length; c++) nextSet[c].env = ch[c].env;
      os = factor;
      ch = nextSet;
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
      // Reset EVERY factor set: an inactive set keeps stale ring content
      // (and a non-unity env) from whenever it was last active — switching
      // back to it later would replay old audio for the lookahead window.
      for (const set of Object.values(chByFactor)) {
        if (!set) continue;
        for (const s of set) {
          s.env = 1; s.wp = 0; s.fill = 0;
          s.ring.fill(0);
          s.os.reset();
        }
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
