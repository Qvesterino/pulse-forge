import type { GenerateOptions } from "../ai/types";
import type { Pattern, ProjectDocument } from "../project-model/types";
import { normalizeIntent, intentFromGenerateOptions } from "./normalize";
import { planGeneration } from "./plan";
import { localDeterministicProvider } from "./providers/local";
import type {
  GenerationContext,
  GenerationResult,
  IntentInput,
  IntentSpec,
  RankedCandidate,
} from "./types";

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
  /**
   * A1 candidate audition: also return the FULL ranked candidate bank on the
   * result (`result.bank`) so the UI can audition every candidate and apply
   * any of them via {@link resultForCandidate}. The bank is in-memory only —
   * it is never serialized into the project.
   */
  includeBank?: boolean;
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
  if (!options.includeBank) {
    const proposal = await localDeterministicProvider.generate(
      plan,
      { project: doc, mode: options.mode ?? "apply" },
      options.signal,
    );
    return resultFromProposal(plan, proposal);
  }
  const ranked = await localDeterministicProvider.generateRanked(
    plan,
    { project: doc, mode: options.mode ?? "apply" },
    options.signal,
  );
  const bank: RankedCandidate[] = ranked.ranked.map((entry, index) => ({
    candidateIndex: entry.candidateIndex,
    seed: entry.seed,
    source: entry.source ?? "template",
    status: entry.status,
    repairs: entry.repairs,
    score: entry.score,
    modelScore: ranked.modelScores[index] ?? null,
    contentHash: entry.contentHash,
    pattern: entry.pattern,
  }));
  return {
    ...resultFromProposal(plan, ranked.proposal),
    bank,
    selection: ranked.ranker,
  };
}

export function generateAsyncResultFromOptions(
  doc: ProjectDocument,
  options: GenerateOptions,
  asyncOptions: GenerateAsyncOptions = {},
): Promise<GenerationResult> {
  return generateAsyncResult(doc, intentFromGenerateOptions(options), asyncOptions);
}

/**
 * A1 candidate audition: build the applyable GenerationResult for ANY bank
 * candidate (not just the engine's default winner). Provenance stays truthful:
 * the pattern keeps its own intent/ranker lineage and gets `ranker.selectedIndex`
 * plus a `selection:user-audition` warning so diagnostics always show that a
 * HUMAN picked this candidate from the bank. Feed the returned result straight
 * into `applyGenerationResultCommand` — one undo step, no regeneration.
 */
export function resultForCandidate(result: GenerationResult, candidateIndex: number): GenerationResult {
  const bank = result.bank;
  if (!bank) throw new Error("result has no candidate bank — regenerate with includeBank: true");
  const entry = bank.find((candidate) => candidate.candidateIndex === candidateIndex);
  if (!entry) {
    throw new Error(`candidate ${candidateIndex} is not in the bank (have: ${bank.map((c) => c.candidateIndex).join(", ")})`);
  }
  const generation = entry.pattern.generation;
  const pattern: Pattern = generation
    ? {
        ...entry.pattern,
        generation: {
          ...generation,
          ...(result.selection
            ? {
                ranker: {
                  featureVersion: result.selection.featureVersion,
                  rankerVersion: result.selection.rankerVersion,
                  modelHash: result.selection.modelHash,
                  selectedIndex: entry.candidateIndex,
                  // Persisted vocabulary predates "off" — see providers/local.ts.
                  mode: result.selection.mode === "active" ? "active" : "shadow",
                  source: result.selection.source,
                },
              }
            : {}),
        },
      }
    : entry.pattern;
  const quality = generation?.quality;
  const warnings = [
    "selection:user-audition",
    `candidate-bank-selected:${entry.candidateIndex}:${entry.source}`,
  ];
  if (quality && !quality.styleAccepted) warnings.push("style-distance-gate-warning");
  const diagnostics = {
    warnings,
    repairs: [...entry.repairs],
    errors: [],
    ...(quality ? { quality } : {}),
  };
  return {
    status: entry.status,
    plan: result.plan,
    proposal: {
      pattern,
      diagnostics,
      status: entry.status,
    },
    diagnostics,
    provider: result.provider,
  };
}

export { normalizeIntent };
