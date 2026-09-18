/**
 * Warp pre-render Web Worker.
 *
 * Runs the phase-vocoder pitch-preserving warp off the main thread so
 * multi-bar texture beds don't block playback or the UI on first use.
 * Pure math — no AudioContext. The engine warms its warp cache through the
 * client (`warp-render-client.ts`); the offline renderer uses the same core
 * synchronously, so live and export are sample-exact.
 *
 * Input:  { channels: Float32Array[], sampleRate: number,
 *           intervals: WarpRateInterval[], outLen: number, fftSize?: number }
 * Output: { channels: Float32Array[] } (transferred) or { error: string }
 */

import { phaseVocoderWarpChannel, warpRateEnvelope, type WarpRateInterval } from "../audio-engine/phase-vocoder";

export interface WarpRenderRequest {
  channels: Float32Array[];
  sampleRate: number;
  intervals: WarpRateInterval[];
  outLen: number;
  fftSize?: number;
}

export interface WarpRenderResponse {
  channels?: Float32Array[];
  error?: string;
}

if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function") {
  (self as unknown as { onmessage: (e: MessageEvent<WarpRenderRequest>) => void }).onmessage = (
    e: MessageEvent<WarpRenderRequest>,
  ) => {
    // Validate before processing — extensions may postMessage into workers
    // that happen to have an onmessage handler.
    const { channels, sampleRate, intervals, outLen, fftSize } = e.data ?? {};
    if (
      !Array.isArray(channels) ||
      channels.length === 0 ||
      !channels.every((c) => c instanceof Float32Array) ||
      typeof sampleRate !== "number" ||
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0 ||
      !Array.isArray(intervals) ||
      typeof outLen !== "number" ||
      !Number.isFinite(outLen) ||
      outLen <= 0
    ) {
      return; // not our message — ignore silently
    }
    try {
      const rateAt = warpRateEnvelope(intervals);
      const rendered = channels.map((ch) =>
        phaseVocoderWarpChannel(ch, sampleRate, rateAt, Math.floor(outLen), fftSize ? { fftSize } : undefined),
      );
      (self as unknown as { postMessage: (msg: WarpRenderResponse, transfer: Transferable[]) => void }).postMessage(
        { channels: rendered },
        rendered.map((c) => c.buffer),
      );
    } catch (err) {
      (self as unknown as { postMessage: (msg: WarpRenderResponse) => void }).postMessage({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
