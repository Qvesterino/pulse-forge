/**
 * Host-side worker for VLYX Mix Assist and Reference Match analysis.
 *
 * The Ultina analysis API is intentionally synchronous so it can also be
 * used by the upstream plugin tests. The KYX host must not call that API on
 * the editor's main thread for a rendered song, though: feature extraction
 * walks every sample and allocates FFT work buffers for every hop. This
 * worker keeps the upstream algorithm unchanged while moving that work out
 * of the UI thread.
 */

import { extractFeatures } from "../effects/ultina-core/analysis/featureExtractor";
import { analyzeTrack, analyzeWithTarget } from "../effects/ultina-core/analysis/mixAssistant";
import type { AnalysisRequest, AnalysisResult } from "../effects/ultina-core/analysis/assistant";
import { integratedLufsStreaming } from "../audio-engine/kweighting";

export type UltinaAnalysisWorkerRequest =
  | {
      id: number;
      kind: "analyze";
      request: AnalysisRequest;
      targetCurve?: number[];
    }
  | {
      id: number;
      kind: "target-curve";
      channels: Float32Array[];
      sampleRate: number;
    }
  | {
      id: number;
      kind: "loudness";
      channels: Float32Array[];
      sampleRate: number;
    };

export interface UltinaTargetCurveResult {
  targetCurve: number[] | null;
  reason?: string;
}

export type UltinaAnalysisWorkerResponse =
  | { id: number; ok: true; kind: "analysis"; result: AnalysisResult }
  | { id: number; ok: true; kind: "target-curve"; result: UltinaTargetCurveResult }
  | { id: number; ok: true; kind: "loudness"; result: { integratedLufs: number | null } }
  | { id: number; ok: false; error: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: UltinaAnalysisWorkerResponse) => void;
};

const scope = globalThis as unknown as Partial<WorkerScope>;

function targetCurveResult(channels: Float32Array[], sampleRate: number): UltinaTargetCurveResult {
  const features = extractFeatures(channels, sampleRate);
  if (!features.valid) {
    return {
      targetCurve: null,
      reason: features.invalidReason ?? "Reference is too short or too quiet to analyze.",
    };
  }

  return {
    targetCurve: features.spectralProfile.map((band) =>
      band.ratio > 0 ? 10 * Math.log10(band.ratio * 10 + 1e-20) : -60,
    ),
  };
}

function isAudioChannels(value: unknown): value is Float32Array[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return false;
  if (!value.every((channel) => channel instanceof Float32Array)) return false;
  return value.every((channel) => channel.length === value[0]?.length);
}

function isWorkerRequest(value: unknown): value is UltinaAnalysisWorkerRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "number" || !Number.isSafeInteger(request.id) || request.id < 0) return false;
  if (request.kind === "target-curve" || request.kind === "loudness") {
    return (
      isAudioChannels(request.channels) &&
      typeof request.sampleRate === "number" &&
      Number.isFinite(request.sampleRate) &&
      request.sampleRate > 0
    );
  }
  if (request.kind !== "analyze" || !request.request || typeof request.request !== "object") return false;
  const analysis = request.request as Record<string, unknown>;
  if (
    !isAudioChannels(analysis.channels) ||
    typeof analysis.sampleRate !== "number" ||
    !Number.isFinite(analysis.sampleRate) ||
    analysis.sampleRate <= 0 ||
    (analysis.minimumDuration !== undefined &&
      (typeof analysis.minimumDuration !== "number" ||
        !Number.isFinite(analysis.minimumDuration) ||
        analysis.minimumDuration < 0))
  ) {
    return false;
  }
  if (request.targetCurve !== undefined) {
    if (
      !Array.isArray(request.targetCurve) ||
      !request.targetCurve.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return false;
    }
  }
  return true;
}

if (typeof scope.postMessage === "function") {
  scope.onmessage = (event: MessageEvent<unknown>) => {
    const rawRequest = event.data;
    const rawId = rawRequest && typeof rawRequest === "object" ? (rawRequest as { id?: unknown }).id : undefined;
    const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? rawId : 0;
    try {
      if (!isWorkerRequest(rawRequest)) throw new Error("Invalid VLYX worker request.");
      const request = rawRequest;
      if (request.kind === "loudness") {
        scope.postMessage?.({
          id: request.id,
          ok: true,
          kind: "loudness",
          result: { integratedLufs: integratedLufsStreaming(request.channels, request.sampleRate) },
        });
        return;
      }
      if (request.kind === "target-curve") {
        scope.postMessage?.({
          id: request.id,
          ok: true,
          kind: "target-curve",
          result: targetCurveResult(request.channels, request.sampleRate),
        });
        return;
      }

      const result = request.targetCurve
        ? analyzeWithTarget(request.request, request.targetCurve)
        : analyzeTrack(request.request);
      scope.postMessage?.({ id: request.id, ok: true, kind: "analysis", result });
    } catch (error) {
      scope.postMessage?.({
        id,
        ok: false,
        error: error instanceof Error ? error.message : "VLYX analysis failed",
      });
    }
  };
}
