import type { GenerateOptions } from "../ai/types";
import type { ProjectDocument } from "../project-model/types";
import { normalizeIntent, intentFromGenerateOptions } from "./normalize";
import { planGeneration } from "./plan";
import { localDeterministicProvider } from "./providers/local";
import type { GenerationContext, GenerationResult, IntentInput, IntentSpec } from "./types";

function resultFromProposal(
  plan: ReturnType<typeof planGeneration>,
  proposal: NonNullable<GenerationResult["proposal"]>,
): GenerationResult {
  return {
    status: proposal.status ?? (proposal.diagnostics.errors.length > 0 ? "rejected" : "accepted"),
    plan,
    proposal,
    diagnostics: proposal.diagnostics,
    provider: {
      id: localDeterministicProvider.id,
      version: localDeterministicProvider.version,
    },
  };
}

/**
 * Synchronous single-candidate fast path.
 *
 * Runs the same provider as {@link generateAsyncResult} but forces the
 * heuristic ranking (no worker/model involvement). Legitimate remaining
 * callers:
 *  - `generatePatternCommand` (direct generate-and-apply flows with no
 *    preview, e.g. AI Flip),
 *  - single-candidate surfaces where the async wrapper is a provable no-op
 *    (the provider short-circuits to this path when candidateCount ≤ 1 —
 *    e.g. the Dice tray's live preview, which must stay synchronous),
 *  - offline tooling (golden baselines, datasets, benchmarks) that must be
 *    reproducible without ONNX availability.
 * Product surfaces with a preview/apply flow or a candidate bank MUST use
 * {@link generateAsyncResult} instead so the configured ranker can actually
 * participate.
 */
export function generateLocalResult(
  doc: ProjectDocument,
  input: IntentInput | IntentSpec,
  mode: GenerationContext["mode"] = "apply",
): GenerationResult {
  const plan = planGeneration(input, doc);
  const proposal = localDeterministicProvider.generateSync(plan, { project: doc, mode });
  return resultFromProposal(plan, proposal);
}

export function generateLocalResultFromOptions(
  doc: ProjectDocument,
  options: GenerateOptions,
  mode: GenerationContext["mode"] = "apply",
): GenerationResult {
  return generateLocalResult(doc, intentFromGenerateOptions(options), mode);
}

export interface GenerateAsyncOptions {
  /** Preview vs apply — recorded in the provider context, no behavioral diff. */
  mode?: GenerationContext["mode"];
  /** Abort support: an aborted generation throws AbortError and produces no result. */
  signal?: AbortSignal;
}

/**
 * Canonical interactive generation entry point.
 *
 * Full pipeline: candidate bank → hard invariants → deterministic repair →
 * heuristic score → ONNX ranker (off/shadow/active, worker-isolated, timeout +
 * circuit breaker) → deterministic fallback when the model is unavailable.
 * Never depends on successful model initialization: every model-side failure
 * degrades to the heuristic-selected result. Equal input + equal engine/model
 * versions reproduce equal output (candidate order never depends on promise
 * completion order).
 *
 * Rejects ONLY on abort (AbortError) — model/generator failures resolve as
 * fallback/rejected results instead.
 */
export async function generateAsyncResult(
  doc: ProjectDocument,
  input: IntentInput | IntentSpec,
  options: GenerateAsyncOptions = {},
): Promise<GenerationResult> {
  const plan = planGeneration(input, doc);
  const proposal = await localDeterministicProvider.generate(
    plan,
    { project: doc, mode: options.mode ?? "apply" },
    options.signal,
  );
  return resultFromProposal(plan, proposal);
}

export function generateAsyncResultFromOptions(
  doc: ProjectDocument,
  options: GenerateOptions,
  asyncOptions: GenerateAsyncOptions = {},
): Promise<GenerationResult> {
  return generateAsyncResult(doc, intentFromGenerateOptions(options), asyncOptions);
}

export { normalizeIntent };
