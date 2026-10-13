/** Optional local mastering ranker. It only observes planner candidates and always runs in shadow mode. */
import { assetUrl } from "../shared/assetUrls";
import {
  isMasteringFeatureVector,
  MASTERING_RANKER_FEATURE_COUNT,
  type MasteringProposalCandidate,
} from "./intelligence";
import {
  evaluationReportMatchesGate,
  hasPassedMasteringRankerEvaluation,
  isMasteringRankerEvaluationReport,
  isMasteringRankerManifest,
  type MasteringRankerManifest,
  type MasteringRankerRequest,
  type MasteringRankerResponse,
} from "./ranker-types";

export type MasteringRankerUnavailableReason =
  | "manifest-unavailable"
  | "manifest-invalid"
  | "worker-unavailable"
  | "inference-failed"
  | "timeout"
  | "cancelled"
  | "invalid-candidates";

export interface MasteringRankerAssessment {
  mode: "shadow";
  status: "compared" | "unavailable" | "no-candidates" | "cancelled";
  /** Model ordering is diagnostic only; the assistant continues to display planner order. */
  shadowOrderIds: string[] | null;
  rankerVersion: string | null;
  evaluationGatePassed: boolean;
  /** Elapsed wall time for this local attempt; it is diagnostic, not a p95 benchmark. */
  durationMs?: number;
  reason?: MasteringRankerUnavailableReason;
}

const MANIFEST_TIMEOUT_MS = 1000;
const LOAD_TIMEOUT_MS = 3000;
const SCORE_TIMEOUT_MS = 400;
const MAX_FAILURES = 3;
const MAX_CANDIDATES = 64;
const MAX_MANIFEST_CHARS = 16_384;
const MAX_EVALUATION_REPORT_CHARS = 32_768;

let worker: Worker | null = null;
let workerFailures = 0;
let workerDisabled = false;
let nextRequestId = 1;
let manifestResult: { manifest: MasteringRankerManifest | null; reason?: MasteringRankerUnavailableReason } | null =
  null;
const evaluationVerification = new Map<string, boolean>();

function spawnWorker(): Worker | null {
  if (workerDisabled || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./mastering-ranker-worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function fallbackResponse(request: MasteringRankerRequest, error: string): MasteringRankerResponse {
  if (request.type === "load") return { type: "load", requestId: request.requestId, ok: false, error };
  if (request.type === "score") return { type: "score", requestId: request.requestId, ok: false, error };
  return { type: "dispose", requestId: request.requestId, ok: false };
}

function request(
  message: MasteringRankerRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MasteringRankerResponse> {
  const active = spawnWorker();
  if (!active) return Promise.resolve(fallbackResponse(message, "worker unavailable"));
  if (signal?.aborted) return Promise.resolve(fallbackResponse(message, "cancelled"));

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      active.removeEventListener("message", onMessage);
      active.removeEventListener("error", onError);
      active.removeEventListener("messageerror", onMessageError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (response: MasteringRankerResponse, failed: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failed) {
        workerFailures += 1;
        if (workerFailures >= MAX_FAILURES) {
          worker?.terminate();
          worker = null;
          workerDisabled = true;
        }
      } else if (response.ok && message.type === "score") {
        workerFailures = 0;
      }
      resolve(response);
    };
    const onMessage = (event: MessageEvent<MasteringRankerResponse>) => {
      const response = event.data;
      if (!response || response.requestId !== message.requestId) return;
      if (response.type !== message.type || typeof response.ok !== "boolean") {
        finish(fallbackResponse(message, "worker response contract invalid"), true);
        return;
      }
      if (
        message.type === "score" &&
        response.ok &&
        (response.type !== "score" ||
          !Array.isArray(response.scores) ||
          response.scores.length !== message.candidateCount ||
          response.scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1))
      ) {
        finish(fallbackResponse(message, "worker score contract invalid"), true);
        return;
      }
      finish(response, response.ok === false);
    };
    const onError = () => finish(fallbackResponse(message, "worker runtime error"), true);
    const onMessageError = () => finish(fallbackResponse(message, "worker response could not be decoded"), true);
    const onAbort = () => finish(fallbackResponse(message, "cancelled"), false);
    const timer = setTimeout(() => finish(fallbackResponse(message, "timeout"), true), timeoutMs);

    active.addEventListener("message", onMessage);
    active.addEventListener("error", onError);
    active.addEventListener("messageerror", onMessageError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      active.postMessage(message);
    } catch {
      finish(fallbackResponse(message, "worker request could not be sent"), true);
    }
  });
}

async function loadManifest(signal?: AbortSignal): Promise<{
  manifest: MasteringRankerManifest | null;
  reason?: MasteringRankerUnavailableReason;
}> {
  if (manifestResult) return manifestResult;
  if (signal?.aborted) return { manifest: null, reason: "cancelled" };
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  signal?.addEventListener("abort", abortRequest, { once: true });
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(assetUrl("/models/mastering-ranker-v1.manifest.json"), { signal: controller.signal });
    if (!response.ok) {
      manifestResult = { manifest: null, reason: "manifest-unavailable" };
      return manifestResult;
    }
    const source = await response.text();
    if (source.length === 0 || source.length > MAX_MANIFEST_CHARS) {
      manifestResult = { manifest: null, reason: "manifest-invalid" };
      return manifestResult;
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      manifestResult = { manifest: null, reason: "manifest-invalid" };
      return manifestResult;
    }
    if (!isMasteringRankerManifest(value)) {
      manifestResult = { manifest: null, reason: "manifest-invalid" };
      return manifestResult;
    }
    manifestResult = { manifest: value };
    return manifestResult;
  } catch {
    return { manifest: null, reason: signal?.aborted ? "cancelled" : "manifest-unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortRequest);
  }
}

async function verifyEvaluationReport(manifest: MasteringRankerManifest, signal?: AbortSignal): Promise<boolean> {
  if (!hasPassedMasteringRankerEvaluation(manifest) || !manifest.evaluation) return false;
  const gate = manifest.evaluation;
  const cacheKey = `${gate.reportPath}:${gate.reportHash}`;
  const cached = evaluationVerification.get(cacheKey);
  if (cached !== undefined) return cached;
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  signal?.addEventListener("abort", abortRequest, { once: true });
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(assetUrl(gate.reportPath), { signal: controller.signal });
    if (!response.ok) return false;
    const source = await response.text();
    if (source.length === 0 || source.length > MAX_EVALUATION_REPORT_CHARS) return false;
    if (!globalThis.crypto?.subtle) return false;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const reportHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    if (reportHash !== gate.reportHash) {
      evaluationVerification.set(cacheKey, false);
      return false;
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      evaluationVerification.set(cacheKey, false);
      return false;
    }
    const valid = isMasteringRankerEvaluationReport(value) && evaluationReportMatchesGate(value, gate);
    evaluationVerification.set(cacheKey, valid);
    return valid;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortRequest);
  }
}

function unavailable(reason: MasteringRankerUnavailableReason, durationMs?: number): MasteringRankerAssessment {
  return {
    mode: "shadow",
    status: reason === "cancelled" ? "cancelled" : "unavailable",
    shadowOrderIds: null,
    rankerVersion: null,
    evaluationGatePassed: false,
    ...(durationMs === undefined ? {} : { durationMs }),
    reason,
  };
}

function elapsedMs(startedAt: number): number {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.max(0, Math.round(now - startedAt));
}

/** Compare the planner's bounded proposals locally; this result never changes proposal order or project state. */
async function compareMasteringCandidatesInShadowModeInternal(
  candidates: readonly MasteringProposalCandidate[],
  signal?: AbortSignal,
): Promise<MasteringRankerAssessment> {
  if (candidates.length === 0) {
    return {
      mode: "shadow",
      status: "no-candidates",
      shadowOrderIds: [],
      rankerVersion: null,
      evaluationGatePassed: false,
    };
  }
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (
    candidates.length > MAX_CANDIDATES ||
    candidates.some((candidate) => !candidate.id || !isMasteringFeatureVector(candidate.featureVector))
  ) {
    return unavailable("invalid-candidates", elapsedMs(startedAt));
  }
  const loaded = await loadManifest(signal);
  if (!loaded.manifest) return unavailable(loaded.reason ?? "manifest-unavailable", elapsedMs(startedAt));
  if (signal?.aborted) return unavailable("cancelled", elapsedMs(startedAt));
  const { manifest } = loaded;
  const load = await request({ type: "load", requestId: nextRequestId++, manifest }, LOAD_TIMEOUT_MS, signal);
  if (!load.ok || load.type !== "load") {
    const error = load.type === "load" ? load.error : undefined;
    return unavailable(
      error === "timeout" ? "timeout" : signal?.aborted ? "cancelled" : "inference-failed",
      elapsedMs(startedAt),
    );
  }
  const batch = new Float32Array(candidates.length * MASTERING_RANKER_FEATURE_COUNT);
  candidates.forEach((candidate, index) => batch.set(candidate.featureVector, index * MASTERING_RANKER_FEATURE_COUNT));
  const score = await request(
    { type: "score", requestId: nextRequestId++, batch, candidateCount: candidates.length },
    SCORE_TIMEOUT_MS,
    signal,
  );
  if (
    !score.ok ||
    score.type !== "score" ||
    !Array.isArray(score.scores) ||
    score.scores.length !== candidates.length ||
    score.scores.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    const error = score.type === "score" ? score.error : undefined;
    return unavailable(
      error === "timeout" ? "timeout" : signal?.aborted ? "cancelled" : "inference-failed",
      elapsedMs(startedAt),
    );
  }
  const shadowOrderIds = candidates
    .map((candidate, index) => ({ candidate, score: score.scores![index]! }))
    .sort((left, right) => right.score - left.score || left.candidate.originalIndex - right.candidate.originalIndex)
    .map(({ candidate }) => candidate.id);
  const evaluationGatePassed = await verifyEvaluationReport(manifest, signal);
  if (signal?.aborted) return unavailable("cancelled", elapsedMs(startedAt));
  return {
    mode: "shadow",
    status: "compared",
    shadowOrderIds,
    rankerVersion: manifest.rankerVersion,
    evaluationGatePassed,
    durationMs: elapsedMs(startedAt),
  };
}

/** Optional AI must never fail the already-complete measurement/planner workflow. */
export async function compareMasteringCandidatesInShadowMode(
  candidates: readonly MasteringProposalCandidate[],
  signal?: AbortSignal,
): Promise<MasteringRankerAssessment> {
  try {
    return await compareMasteringCandidatesInShadowModeInternal(candidates, signal);
  } catch {
    return unavailable(signal?.aborted ? "cancelled" : "inference-failed");
  }
}

export function masteringRankerStatusText(assessment: MasteringRankerAssessment): string {
  if (assessment.status === "compared") {
    const duration = assessment.durationMs === undefined ? "" : ` · ${assessment.durationMs} ms this run`;
    const gate = assessment.evaluationGatePassed
      ? " Its evaluation gate is recorded as passed, but this run remains shadow-only."
      : " It has not passed the activation evaluation gate and remains shadow-only.";
    return `Local ranker ${assessment.rankerVersion ?? "model"} ran in shadow mode${duration}. The displayed order still comes from deterministic rules.${gate}`;
  }
  if (assessment.status === "no-candidates") return "No bounded candidates were available for local ranking.";
  if (assessment.status === "cancelled") return "Local shadow ranking was cancelled; deterministic order is unchanged.";
  if (assessment.reason === "manifest-invalid")
    return "The local mastering model manifest is invalid. Deterministic proposal order is unchanged.";
  if (assessment.reason === "manifest-unavailable")
    return "No local mastering model is installed. Deterministic proposals remain in use.";
  return "The local mastering model could not run. Deterministic proposal order is unchanged.";
}

/** Test/diagnostic hook for model replacement and failure-recovery checks. */
export function resetMasteringRankerClient(): void {
  worker?.terminate();
  worker = null;
  workerFailures = 0;
  workerDisabled = false;
  nextRequestId = 1;
  manifestResult = null;
  evaluationVerification.clear();
}
