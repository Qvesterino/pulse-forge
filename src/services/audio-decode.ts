/**
 * AUDIO DECODE CONTRACT (cross-platform campaign GOAL 03).
 *
 * Several storage/library layers need to turn audio BYTES into AudioBuffers
 * (user sample restore, frozen-track restore, recording recovery, curated
 * bank loading). They previously each spun a throwaway
 * `OfflineAudioContext(1, 1, 44100)` just to reach `decodeAudioData` — which
 * silently makes *persistence* require the Web Audio API. This module is
 * the single seam: default implementation keeps today's exact behavior; a
 * non-Web-Audio platform injects its decoder once at boot.
 *
 * Responsibilities: bytes → AudioBuffer. Inputs: encoded audio bytes
 * (wav/mp3/… whatever the platform decoder supports) + the sample rate used
 * for the throwaway context (decoding resamples to the context rate on the
 * web — part of the observable contract). Outputs: decoded AudioBuffer.
 * Error model: rejects with the underlying decoder's error on malformed
 * bytes. Lifecycle: injection at boot before first restore; no state.
 * Cancellation: none (decode is atomic). Capability limits: only as good as
 * the host decoder; web default inherits browser codec support.
 */

export type AudioDecoder = (bytes: ArrayBuffer, sampleRate: number) => Promise<AudioBuffer>;

let injected: AudioDecoder | null = null;

/** Install a platform decoder (native shell, tests). Pass null to restore the Web Audio default. */
export function setAudioDecoder(decoder: AudioDecoder | null): void {
  injected = decoder;
}

/** Decode audio bytes, preferring the injected platform decoder. */
export function decodeAudioData(bytes: ArrayBuffer, sampleRate = 44100): Promise<AudioBuffer> {
  if (injected) return injected(bytes, sampleRate);
  if (typeof OfflineAudioContext === "undefined") {
    return Promise.reject(new Error("No audio decoder available on this platform"));
  }
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  return ctx.decodeAudioData(bytes);
}
