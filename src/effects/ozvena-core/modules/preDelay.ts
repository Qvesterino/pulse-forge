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
// (Reconciled from Pulse Forge hardening pass, 2026-09-14: NaN ms degrades to 0.)
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
import { clamp } from "../dsp/math.js";
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
  // Per-channel delay line (circular buffer) + write index. The complete
  // supported range is reserved in prepare(), so parameter and tempo changes
  // never resize or copy audio memory from the render callback. At 48 kHz the
  // stereo worst case is ~37 MB (8 measures at 20 BPM); that bounded startup
  // cost is preferable to an unbounded dropout risk while playing.
  let buffers: Float32Array[] = [];
  let writeIdx: number[] = [];
  let ringLength = 0;
  function maxSupportedDelaySamples(): number {
    return Math.max(
      Math.ceil((500 / 1000) * sampleRate),
      Math.ceil(((syncNoteToBeats("8/1") * 60) / 20) * sampleRate),
    );
  }
  function ensureBuffers(): void {
    // +1 lets a delay equal to the maximum supported length read the slot
    // immediately before the write cursor without aliasing the current sample.
    const capacity = maxSupportedDelaySamples() + 1;
    // (Reconciled from Pulse Forge hardening audit, 2026-09-07.)
    // (Reconciled from Pulse Forge hardening audit, 2026-09-09.)
    if (buffers.length === channelCount && ringLength === capacity) return;
    buffers = [];
    writeIdx = [];
    for (let c = 0; c < channelCount; c++) {
      buffers.push(new Float32Array(capacity));
      writeIdx.push(0);
    }
    ringLength = capacity;
  }
  function recomputeDelaySamples(): void {
    // NaN/Infinity ms (corrupt direct-core state) must degrade to 0 —
    // Math.max(0, Math.round(NaN)) is NaN, which slips past both the
    // `<= 0` process gate and the `> cap` clamp and reads dly[NaN].
    const ms = Number.isFinite(params.ms) ? params.ms : 0;
    if (params.syncEnabled) {
      const beats = syncNoteToBeats(params.syncNote);
      delaySamples = Math.max(0, Math.round((60 / Math.max(1e-3, bpm)) * beats * sampleRate));
      // Guard: never exceed the prepared buffer (worst-case sizing is
      // 8 measures @ 20 BPM; clamp defensively so a corrupted BPM can
      // never wrap the delay line).
      const cap = maxSupportedDelaySamples();
      if (delaySamples > cap) delaySamples = cap;
    } else {
      delaySamples = Math.max(0, Math.round((ms / 1000) * sampleRate));
      const cap = maxSupportedDelaySamples();
      if (delaySamples > cap) delaySamples = cap;
    }
  }
  // Delay-time change crossfade. Jumping the read pointer produces a
  // click on every knob move / automation event; a short equal-gain
  // crossfade between the old and new read positions makes changes
  // inaudible. Must mirror the native engine (ozvena_pre_delay.h).
  const FADE_SECONDS = 0.02;
  let activeDelaySamples = -1; // delay length currently in effect (-1 = init)
  let fadeFromSamples = -1; // previous length during a crossfade (-1 = none)
  let fadePos = 0; // samples elapsed in the current crossfade
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
      if (buffers.length !== channelCount || ringLength <= 0) return;
      const d = delaySamples;
      if (activeDelaySamples < 0) activeDelaySamples = d;
      if (d !== activeDelaySamples) {
        fadeFromSamples = activeDelaySamples;
        fadePos = 0;
        activeDelaySamples = d;
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
          let readIdx = wi - d;
          if (readIdx < 0) readIdx += ringLength;
          let delayed = dly[readIdx];
          if (fadeT >= 0) {
            // Crossfade from the previous delay length (both read
            // distances are covered by the ring span, so both slots are
            // valid reads).
            let readOld = wi - fadeFromSamples;
            if (readOld < 0) readOld += ringLength;
            delayed = dly[readOld] * (1 - fadeT) + delayed * fadeT;
          }
          dly[wi] = buf[i];
          buf[i] = delayed;
          wi++;
          if (wi >= ringLength) wi = 0;
          writeIdx[c] = wi;
        }
      }
    },
    setParams(p) {
      params = { ...p };
      recomputeDelaySamples();
    },
    setBpm(hostBpm) {
      bpm = clamp(hostBpm, 20, 300);
      recomputeDelaySamples();
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
