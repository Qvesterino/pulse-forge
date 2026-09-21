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
import { createPolyphaseOversampler, type PolyphaseOversampler, type OversampleFactor } from "../dsp/oversampler.js";

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
   * pointer swap plus an envelope carry-over and a lookahead prime from
   * recent input history (no stale replay, no timing jump — total latency
   * is factor-independent, see getLatencySamples). The processor calls this
   * from the realtime path on quality changes; calling prepare() there
   * instead would allocate and zero ~0.5 MB of rings on the audio thread.
   * (Reconciled from Pulse Forge, 2026-09-05.)
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

export function createSafetyLimiter(): SafetyLimiter {
  let prepared = false;
  let sampleRate = 48000;
  let ceilDb = DEFAULT_CEIL_DB;
  let os: OversampleFactor = 4;

  let laOvs = 0;
  let ringCap = 0;
  // Constant-latency compensation (2026-09-19 audit #5): every oversample
  // factor has a different FIR group delay (0/16/24/32 input samples for
  // 1/2/4/8x), so switching quality moved the whole output in time — a
  // ~0.4–0.5 sample step on ordinary material. The input is delayed by
  // (maxOsLat - currentOsLat) so the TOTAL latency (laSamples + maxOsLat)
  // is identical at every tier; a quality switch then only changes the
  // filter kernels, never the timing. getLatencySamples() reports that
  // constant (previously it tracked the factor: 96/112/120/128 @48k).
  let maxOsLat = 0;
  let laSamples = 0;
  // Post-pad input history (input-rate samples) feeding two jobs: the
  // constant-latency pad read, and priming a fresh factor's lookahead ring
  // on a switch (see setOversampleFactor). Sized for the lookahead window
  // plus the max pad plus one block, so any read below stays in range.
  let histRing: Float32Array[] = [];
  let histCap = 0;
  let histWp = 0;
  // Scratch for the prime segment (lookahead window copied out of histRing
  // before upsampling — the ring may wrap). Sized once in prepare().
  let primeScratch = new Float32Array(0);
  // FIR warmup for the prime run, in input samples. A freshly reset
  // upsampler starts from a zeroed delay line, so its first ~tapsPerPhase
  // outputs ramp from silence — priming with those would bake a dip into
  // the lookahead window. Run WARM extra history first and discard it.
  // 64 covers the largest kernel (32 taps/phase at 8x) with margin.
  const PRIME_WARM = 64;
  // ACTIVE channel set (pointer into chByFactor — reassigned by
  // setOversampleFactor, never mutated there).
  let ch: Chan[] = [];
  // One prepared channel set per oversample factor, built eagerly in
  // prepare() so quality changes are allocation-free.
  const chByFactor: Partial<Record<OversampleFactor, Chan[]>> = {};
  const OS_FACTORS: readonly OversampleFactor[] = [1, 2, 4, 8];

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
    const ringStart = (((s.wp - totalEp) % ringCap) + ringCap) % ringCap;
    for (let i = 0; i < totalEp; i++) {
      const ri = (ringStart + i) % ringCap;
      const a = s.ring[ri];
      const abs = a < 0 ? -a : a;
      let ep = abs;
      if (i < totalEp - 1) {
        const ni = (ri + 1) % ringCap;
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
  }

  function processLinked(
    channels: Float32Array[],
    n: number,
    ceil: number,
    rc: number,
    upLen: number,
    effLA: number,
    totalEp: number,
  ): void {
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

      let dqHead = 0,
        dqTail = 0,
        outIdx = 0;
      for (let j = 0; j < totalEp; j++) {
        while (dqTail > dqHead && epScratch[j] >= epScratch[dequeIdx[dqTail - 1]]) dqTail--;
        dequeIdx[dqTail] = j;
        dequeVal[dqTail] = epScratch[j];
        dqTail++;
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
        const op = (((s.wp - upLen + i - effLA) % ringCap) + ringCap) % ringCap;
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

  function processUnlinked(
    channels: Float32Array[],
    n: number,
    ceil: number,
    rc: number,
    upLen: number,
    effLA: number,
    totalEp: number,
  ): void {
    for (let c = 0; c < channels.length; c++) {
      const s = ch[c];
      const up = s.os.upsample(channels[c], n);
      for (let i = 0; i < upLen; i++) s.ring[(s.wp + i) % ringCap] = up[i];
      s.wp = (s.wp + upLen) % ringCap;
      s.fill = Math.min(s.fill + upLen, ringCap);

      computeEffectivePeaks(s, totalEp);

      let dqHead = 0,
        dqTail = 0,
        outIdx = 0;
      for (let j = 0; j < totalEp; j++) {
        while (dqTail > dqHead && epScratch[j] >= epScratch[dequeIdx[dqTail - 1]]) dqTail--;
        dequeIdx[dqTail] = j;
        dequeVal[dqTail] = epScratch[j];
        dqTail++;
        while (dqHead < dqTail && dequeIdx[dqHead] < j - effLA) dqHead++;
        if (j >= effLA) {
          const peak = dequeVal[dqHead];
          let tgt = 1;
          if (peak > ceil && peak > 1e-9) tgt = ceil / peak;
          s.env = tgt < s.env ? tgt : s.env * rc + tgt * (1 - rc);
          const op = (((s.wp - upLen + outIdx - effLA) % ringCap) + ringCap) % ringCap;
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
      // never overflows it between re-prepares.
      const maxLaOvs = Math.round((MAX_LA_MS / 1000) * sampleRate) * OS_MAX;
      ringCap = maxLaOvs + OS_MAX * maxBs;
      // Build a channel set for EVERY supported factor: allocation happens
      // only here (constructor/reset), never on a quality change mid-render.
      const cc = Math.max(1, channelCount);
      for (const f of OS_FACTORS) {
        chByFactor[f] = buildChannels(cc, f);
      }
      ch = chByFactor[os] as Chan[];
      // Worst-case oversampler group delay over all tiers (input samples;
      // the FIR tap counts are rate-independent so this is a constant).
      maxOsLat = 0;
      for (const f of OS_FACTORS) {
        const set = chByFactor[f];
        if (set && set.length > 0) maxOsLat = Math.max(maxOsLat, set[0].os.latencySamples);
      }
      laSamples = Math.round((LOOKAHEAD_MS / 1000) * sampleRate);
      histCap = laSamples + maxOsLat + PRIME_WARM + maxBs + 8;
      histRing = [];
      for (let i = 0; i < cc; i++) histRing.push(new Float32Array(histCap));
      histWp = 0;
      primeScratch = new Float32Array(Math.max(8, laSamples + PRIME_WARM + 4));
      prepared = true;
    },

    setOversampleFactor(factor) {
      if (!prepared) return;
      if (factor !== 1 && factor !== 2 && factor !== 4 && factor !== 8) return;
      if (factor === os) return;
      const nextSet = chByFactor[factor];
      if (!nextSet) return;
      const nextLaOvs = laSamples * factor;
      for (let c = 0; c < ch.length && c < nextSet.length; c++) {
        const n = nextSet[c];
        // Carry the gain envelope across the switch: while the bus was
        // limiting, a reset env=1 would be an instantaneous gain jump (an
        // audible click on every quality change).
        n.env = ch[c].env;
        // Prime the lookahead window from recent input history instead of
        // leaving it silent. The old code zeroed the ring with `fill = 0`,
        // which collapsed effLA and jumped the output forward a whole
        // lookahead window (43–72x natural slope); the 2026-09-19 interim
        // fix (zeroed ring + `fill = laOvs`) kept alignment but emitted a
        // ≤2 ms silence gap. Re-running the recent padded input through
        // the NEW oversampler produces bit-plausible lookahead content —
        // the same samples the new chain would have cached had it been
        // active — so the first post-switch block continues the waveform.
        // (Reconciled from Pulse Forge hardening audit, 2026-09-08, and
        // Pulse Forge audit, 2026-09-19.)
        n.os.reset();
        n.ring.fill(0);
        const padNew = maxOsLat - n.os.latencySamples;
        const hist = c < histRing.length ? histRing[c] : null;
        if (hist && laSamples > 0) {
          const warmLen = laSamples + PRIME_WARM;
          for (let i = 0; i < warmLen; i++) {
            const idx = (((histWp - padNew - warmLen + i) % histCap) + histCap) % histCap;
            primeScratch[i] = hist[idx];
          }
          const up = n.os.upsample(primeScratch, warmLen);
          // Drop the FIR warmup transient, keep the settled tail.
          const upSkip = PRIME_WARM * factor;
          for (let i = 0; i < nextLaOvs && upSkip + i < up.length; i++) n.ring[i] = up[upSkip + i];
          // Warm the DOWN FIR with the DISCARDED prefix — the delay line
          // must hold content ending exactly where the primed ring content
          // begins. Warming with the tail (as first written) positioned the
          // state ~96 samples in the future, producing a ~12-sample garbage
          // transient on the first post-switch outputs.
          n.os.downsample(up, upSkip); // discard — warms the down FIR only
        }
        n.wp = Math.min(n.ring.length, nextLaOvs);
        n.fill = Math.min(n.ring.length, nextLaOvs);
      }
      os = factor;
      ch = nextSet;
    },

    process(channels, frameCount) {
      if (!prepared || frameCount <= 0 || ch.length === 0) return;
      const n = frameCount;
      // Constant-latency input pad (2026-09-19 audit #5): delay the input
      // by (maxOsLat - currentOsLat) so the TOTAL latency (pad + oversampler
      // group delay + lookahead) is identical at every quality tier. A
      // quality switch then only swaps filter kernels, never the output
      // timing — the ~0.4-sample step from the group-delay jump is gone.
      // In-place forward iteration is safe: the read index always trails
      // the write index by `pad`. Raw (pre-pad) input is appended to the
      // history ring for setOversampleFactor priming.
      while (histRing.length < channels.length) histRing.push(new Float32Array(histCap));
      const pad = Math.max(0, maxOsLat - (ch.length > 0 ? ch[0].os.latencySamples : 0));
      for (let c = 0; c < channels.length && c < histRing.length; c++) {
        const hist = histRing[c];
        const buf = channels[c];
        for (let i = 0; i < n; i++) {
          hist[(histWp + i) % histCap] = buf[i];
          if (pad > 0) buf[i] = hist[(((histWp + i - pad) % histCap) + histCap) % histCap];
        }
      }
      histWp = (histWp + n) % histCap;
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
          s.env = 1;
          s.wp = 0;
          s.fill = 0;
          s.ring.fill(0);
          s.os.reset();
        }
      }
      for (const h of histRing) h.fill(0);
      histWp = 0;
    },

    getLatencySamples() {
      // Constant across quality tiers by construction (see the pad in
      // process()): lookahead + the worst-case oversampler group delay.
      // Previously this tracked the active factor (96/112/120/128 @48k),
      // so every quality switch also jumped the host PDC.
      // (Reconciled from Pulse Forge audit, 2026-09-19.)
      return laSamples + maxOsLat;
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
