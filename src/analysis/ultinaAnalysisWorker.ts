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
    };

export interface UltinaTargetCurveResult {
  targetCurve: number[] | null;
  reason?: string;
}

export type UltinaAnalysisWorkerResponse =
  | { id: number; ok: true; kind: "analysis"; result: AnalysisResult }
  | { id: number; ok: true; kind: "target-curve"; result: UltinaTargetCurveResult }
  | { id: number; ok: false; error: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<UltinaAnalysisWorkerRequest>) => void) | null;
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

if (typeof scope.postMessage === "function") {
  scope.onmessage = (event) => {
    const request = event.data;
    try {
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
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "VLYX analysis failed",
      });
    }
  };
}
