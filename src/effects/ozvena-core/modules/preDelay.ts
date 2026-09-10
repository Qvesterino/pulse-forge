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
// Ozvena — Pre-Delay module
//
// Simple stereo circular-buffer delay. When `syncEnabled` is true the
// delay time is derived from a tempo-sync note value (128th → 8 measures,
// including dotted + triplet variants) and the host BPM. When
// `syncEnabled` is false the time is `ms` directly (0–500 ms).
//
// Per-channel delay line, sample-accurate, allocation-free in steady
// state. Latency = 0 (the delay is user-intentional).
// ═══════════════════════════════════════════════════════════

import { SYNC_NOTE_VALUES, type SyncNoteValue } from "../v2/types.js";
import { clamp, nextPow2 } from "../dsp/math.js";

export interface PreDelayParams {
  enabled: boolean;
  ms: number;
  syncEnabled: boolean;
  syncNote: SyncNoteValue;
}

export interface PreDelay {
  prepare(sampleRate: number, channelCount: number, bpm: number): void;
  process(channels: Float32Array[], frameCount: number): void;
  setParams(p: PreDelayParams): void;
  /** Live tempo update — recomputes the synced delay without a re-prepare. */
  setBpm(bpm: number): void;
  getDelaySamples(): number;
  reset(): void;
}

/**
 * Map a SyncNoteValue to a duration in beats. A whole note = 4 beats.
 * Dotted suffix multiplies by 1.5; T suffix divides by 3 (triplet).
 *
 *   "1/4"   → 1.0 beats (quarter)
 *   "1/4T"  → 1.0 / 3   beats (quarter triplet)
 *   "1/4."  → 1.0 * 1.5 beats (dotted quarter)
 *   "1/8"   → 0.5 beats
 *   "1/8T"  → 0.5 / 3 beats
 *   "1/8."  → 0.5 * 1.5 beats
 *   "1/2"   → 2.0 beats
 *   "1/1"   → 4.0 beats (whole)
 *   "2/1"   → 8.0 beats
 *   "8/1"   → 32.0 beats (8 measures)
 */
export function syncNoteToBeats(note: SyncNoteValue): number {
  const raw = note.replace(/\.$/, "").replace(/T$/, "");
  const suffixDotted = note.endsWith(".");
  const suffixTriplet = note.endsWith("T");

  const [numStr, denomStr] = raw.split("/");
  const num = Number(numStr);
  const denom = Number(denomStr);
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return 1.0;
  // A whole note = 4 quarter-beats
  let beats = (4 * num) / denom;
  if (suffixTriplet) beats /= 3;
  if (suffixDotted) beats *= 1.5;
  return beats;
}

export function createPreDelay(): PreDelay {
  let sampleRate = 44100;
  let channelCount = 2;
  let bpm = 120;

  let params: PreDelayParams = {
    enabled: true,
    ms: 20,
    syncEnabled: false,
    syncNote: "1/4",
  };

  let delaySamples = 0;
  // Per-channel delay line (circular buffer) + write index. Buffers grow
  // LAZILY to cover the current delay need (power-of-two capacity + wrap
  // mask). The old implementation always allocated the worst case — 8
  // measures of sync at 20 BPM ≈ 96 s — which is ~37 MB per instance at
  // 48 kHz and a multi-millisecond zeroing stall at creation, even though
  // the default 20 ms pre-delay needs 960 samples.
  let buffers: Float32Array[] = [];
  let writeIdx: number[] = [];
  let ringMask = 0;

  /** Samples the rings must be able to span: the active delay and, during
   *  a delay-time crossfade, the previous length. */
  function requiredSpan(): number {
    const fade = fadeFromSamples > 0 ? fadeFromSamples : 0;
    return Math.max(delaySamples, fade) + 1;
  }

  function ensureBuffers(): void {
    const need = requiredSpan();
    if (buffers.length === channelCount && buffers[0] && buffers[0].length >= need) return;
    const cap = nextPow2(need);
    // Growth must PRESERVE the delay history in logical (time) order. A
    // fresh zeroed ring here silently discarded the current tail, so the
    // delay-time crossfade blended against silence instead of the old read
    // — an audible dip every time a delay sweep crossed a power-of-two
    // capacity boundary. Copy distance-d history to the same distance in
    // the new ring (old write cursors stay valid: oldCap ≤ newCap).
    // (Reconciled from Pulse Forge hardening audit, 2026-09-07.)
    const prevBuffers = buffers;
    const prevWrite = writeIdx;
    buffers = [];
    writeIdx = [];
    // Only history within REACHABLE read distance can ever be read again:
    // max(new delay, the delay in effect before this change, the old
    // length mid-crossfade) + 1. Bounding the copy by that — instead of
    // the whole old ring — keeps a growth pass proportional to the delay
    // IN USE (a 10→400 ms sweep copies ≤ 19k samples, not megabytes), and
    // is provably output-identical: reads never reach past that distance.
    // (Reconciled from Pulse Forge hardening audit, 2026-09-09.)
    const reachable =
      Math.max(
        delaySamples,
        activeDelaySamples > 0 ? activeDelaySamples : 0,
        fadeFromSamples > 0 ? fadeFromSamples : 0,
      ) + 1;
    for (let c = 0; c < channelCount; c++) {
      const nb = new Float32Array(cap);
      const ob = prevBuffers[c];
      if (ob && ob.length > 0 && (prevWrite[c] ?? 0) >= 0) {
        const wi = prevWrite[c];
        const oldLen = ob.length;
        const keep = Math.min(oldLen, reachable);
        for (let d = 0; d < keep; d++) {
          const src = ((wi - d) % oldLen + oldLen) % oldLen;
          nb[(wi - d) & (cap - 1)] = ob[src];
        }
      }
      buffers.push(nb);
      writeIdx.push(prevWrite[c] ?? 0);
    }
    ringMask = cap - 1;
  }

  function recomputeDelaySamples(): void {
    if (params.syncEnabled) {
      const beats = syncNoteToBeats(params.syncNote);
      delaySamples = Math.max(0, Math.round((60 / Math.max(1e-3, bpm)) * beats * sampleRate));
      // Guard: never exceed the allocated buffer (worst-case sizing is
      // 8 measures @ 20 BPM; clamp defensively so a corrupted BPM can
      // never wrap the delay line).
      const cap = Math.ceil((syncNoteToBeats("8/1") * 60 / 20) * sampleRate);
      if (delaySamples > cap) delaySamples = cap;
    } else {
      delaySamples = Math.max(0, Math.round((params.ms / 1000) * sampleRate));
      const cap = Math.ceil((500 / 1000) * sampleRate);
      if (delaySamples > cap) delaySamples = cap;
    }
  }

  // Delay-time change crossfade. Jumping the read pointer produces a
  // click on every knob move / automation event; a short equal-gain
  // crossfade between the old and new read positions makes changes
  // inaudible. Must mirror the native engine (ozvena_pre_delay.h).
  const FADE_SECONDS = 0.02;
  let activeDelaySamples = -1; // delay length currently in effect (-1 = init)
  let fadeFromSamples = -1;    // previous length during a crossfade (-1 = none)
  let fadePos = 0;             // samples elapsed in the current crossfade

  return {
    prepare(sr, cc, hostBpm) {
      sampleRate = clamp(sr, 8000, 192000);
      channelCount = Math.max(1, cc);
      bpm = clamp(hostBpm, 20, 300);
      recomputeDelaySamples();
      ensureBuffers();
      activeDelaySamples = -1; // re-initialised on the next process()
      fadeFromSamples = -1;
      fadePos = 0;
    },

    process(channels, frameCount) {
      if (!params.enabled || delaySamples <= 0 || frameCount <= 0) return;
      ensureBuffers();

      const d = delaySamples;
      if (activeDelaySamples < 0) activeDelaySamples = d;
      if (d !== activeDelaySamples) {
        fadeFromSamples = activeDelaySamples;
        fadePos = 0;
        activeDelaySamples = d;
        ensureBuffers();
      }
      const fadeLen = Math.max(1, Math.round(FADE_SECONDS * sampleRate));

      // The crossfade position is a function of TIME, so it advances once
      // per sample and applies to every channel identically.
      for (let i = 0; i < frameCount; i++) {
        let fadeT = -1; // < 0 → no crossfade this sample
        if (fadeFromSamples >= 0 && fadePos < fadeLen) {
          fadeT = fadePos / fadeLen;
          fadePos++;
          if (fadePos >= fadeLen) fadeFromSamples = -1;
        }
        for (let c = 0; c < channels.length; c++) {
          if (c >= buffers.length) continue;
          const buf = channels[c];
          const dly = buffers[c];
          let wi = writeIdx[c];

          // Read delayLen ago, then write current.
          let delayed = dly[(wi - d) & ringMask];
          if (fadeT >= 0) {
            // Crossfade from the previous delay length (both read
            // distances are covered by the ring span, so both slots are
            // valid reads).
            const readOld = (wi - fadeFromSamples) & ringMask;
            delayed = dly[readOld] * (1 - fadeT) + delayed * fadeT;
          }
          dly[wi] = buf[i];
          buf[i] = delayed;
          wi = (wi + 1) & ringMask;
          writeIdx[c] = wi;
        }
      }
    },

    setParams(p) {
      params = { ...p };
      recomputeDelaySamples();
      ensureBuffers();
    },

    setBpm(hostBpm) {
      bpm = clamp(hostBpm, 20, 300);
      recomputeDelaySamples();
      ensureBuffers();
    },

    getDelaySamples() {
      return params.enabled ? delaySamples : 0;
    },

    reset() {
      for (const b of buffers) b.fill(0);
      for (let i = 0; i < writeIdx.length; i++) writeIdx[i] = 0;
      activeDelaySamples = -1;
      fadeFromSamples = -1;
      fadePos = 0;
    },
  };
}

// Re-export the note enum for convenience.
export { SYNC_NOTE_VALUES };
