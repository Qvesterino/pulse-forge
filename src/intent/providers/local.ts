import { generatePattern } from "../../ai/generator";
import { inspectPatternInvariants } from "../../ai/invariants";
import { LOCAL_ENGINE_ID, LOCAL_ENGINE_VERSION } from "../../ai/evaluation";
import type { GenerateOptions } from "../../ai/types";
import type { Pattern, ProjectDocument } from "../../project-model/types";
import { rankCandidateBank, type CandidateBankEntry } from "../candidate-bank";
import { rankCandidatesWithModel } from "../../ai/ranking/rank-candidates";
import { rankerMode } from "../../ai/ranking/ranker-client";
import {
  createFallbackPattern,
  refreshPatternQuality,
  repairGeneratedPattern,
  refreshPatternOutputHash,
} from "../quality";
import type {
  GenerationContext,
  GenerationDiagnostics,
  GenerationPlan,
  GenerationProposal,
  GenerationProvider,
} from "../types";

type PatternGenerator = (doc: ProjectDocument, options: GenerateOptions) => Pattern;

function diagnosticsFor(
  pattern: Pattern,
  repairs: string[] = [],
  warnings: string[] = [],
  errors: string[] = [],
  fallbackReason?: string,
): GenerationDiagnostics {
  const quality = pattern.generation?.quality;
  const allWarnings = [...warnings];
  if (quality && !quality.styleAccepted) allWarnings.push("style-distance-gate-warning");
  return {
    warnings: [...new Set(allWarnings)],
    repairs: [...new Set(repairs)],
    errors: [...new Set(errors)],
    ...(fallbackReason ? { fallbackReason } : {}),
    quality,
  };
}

function attachProvenance(pattern: Pattern, plan: GenerationPlan, doc: ProjectDocument): Pattern {
  const intentMetadata = JSON.parse(JSON.stringify(plan.intent)) as Record<string, unknown>;
  const generation = pattern.generation ?? plan.recipe;
  return refreshPatternOutputHash(doc, {
    ...pattern,
    generation: {
      ...generation,
      intentHash: plan.intentHash,
      intent: intentMetadata,
      ...(plan.resolvedBpm !== null ? { resolvedBpm: plan.resolvedBpm } : {}),
      ...(plan.options.candidateCount !== undefined && plan.options.candidateCount > 1
        ? { candidateCount: plan.options.candidateCount }
        : {}),
    },
  });
}

function invariantErrors(report: ReturnType<typeof inspectPatternInvariants>): string[] {
  return report.issues.map((issue) => `invariant:${issue.code}`);
}

function candidatePlan(plan: GenerationPlan, seed: string): GenerationPlan {
  return {
    ...plan,
    options: { ...plan.options, seed },
    recipe: { ...plan.recipe, seed },
  };
}

function evaluateCandidate(
  candidate: Pattern,
  plan: GenerationPlan,
  context: GenerationContext,
): { pattern: Pattern; status: "accepted" | "repaired"; repairs: string[] } | null {
  const effectiveKey = plan.options.key ?? context.project.key;
  const attached = attachProvenance(candidate, plan, context.project);
  const report = inspectPatternInvariants(context.project, attached, {
    checkScale: Boolean(effectiveKey),
    key: effectiveKey,
  });
  if (report.ok) return { pattern: attached, status: "accepted", repairs: [] };

  const repaired = repairGeneratedPattern(context.project, attached, plan.options.stepCount, effectiveKey);
  const repairedPattern = attachProvenance(repaired.pattern, plan, context.project);
  const repairedReport = inspectPatternInvariants(context.project, repairedPattern, {
    checkScale: Boolean(effectiveKey),
    key: effectiveKey,
  });
  if (!repairedReport.ok) return null;
  return {
    pattern: refreshPatternQuality(context.project, repairedPattern, plan.options),
    status: "repaired",
    repairs: repaired.repairs.length > 0 ? repaired.repairs : invariantErrors(report),
  };
}

/** Synchronous local implementation used by commands, with async provider parity. */
export class LocalDeterministicProvider implements GenerationProvider {
  readonly id = LOCAL_ENGINE_ID;
  readonly version = LOCAL_ENGINE_VERSION;
  readonly capabilities = ["offline", "drums", "bass", "chords", "lead", "deterministic"] as const;
  private readonly generator: PatternGenerator;

  constructor(generator: PatternGenerator = generatePattern) {
    this.generator = generator;
  }

  private collectCandidates(
    plan: GenerationPlan,
    context: GenerationContext,
  ): { candidates: CandidateBankEntry[]; failures: string[]; candidateSeeds: readonly string[] } {
    const candidates: CandidateBankEntry[] = [];
    const failures: string[] = [];
    const candidateSeeds = plan.candidateSeeds.length > 0 ? plan.candidateSeeds : [plan.options.seed];

    for (const [candidateIndex, seed] of candidateSeeds.entries()) {
      const currentPlan = candidatePlan(plan, seed);
      try {
        const evaluated = evaluateCandidate(this.generator(context.project, currentPlan.options), currentPlan, context);
        if (!evaluated) {
          failures.push(`candidate-${candidateIndex}:invariant-gate`);
          continue;
        }
        candidates.push({
          candidateIndex,
          seed,
          pattern: evaluated.pattern,
          status: evaluated.status,
          repairs: evaluated.repairs,
          score: 0,
          contentHash: "",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`candidate-${candidateIndex}:generator-error:${reason}`);
      }
    }
    return { candidates, failures, candidateSeeds };
  }

  generateSync(plan: GenerationPlan, context: GenerationContext): GenerationProposal {
    const effectiveKey = plan.options.key ?? context.project.key;
    const { candidates, failures, candidateSeeds } = this.collectCandidates(plan, context);

    const ranked = rankCandidateBank(context.project, candidates);
    if (ranked.length > 0) {
      const selected = ranked[0];
      const bankWarnings =
        candidateSeeds.length > 1
          ? [`candidate-bank-enabled`, `candidate-bank-selected:${selected.candidateIndex}`]
          : [];
      if (failures.length > 0) bankWarnings.push(...failures.map((failure) => `candidate-bank-skipped:${failure}`));
      return {
        status: selected.status,
        pattern: selected.pattern,
        diagnostics: diagnosticsFor(selected.pattern, selected.repairs, bankWarnings),
      };
    }

    const fallback = attachProvenance(createFallbackPattern(context.project, plan.options), plan, context.project);
    const fallbackReport = inspectPatternInvariants(context.project, fallback, {
      checkScale: Boolean(effectiveKey),
      key: effectiveKey,
    });
    if (fallbackReport.ok) {
      return {
        status: "fallback",
        pattern: fallback,
        diagnostics: diagnosticsFor(
          fallback,
          [],
          ["local-generator-fallback", ...failures],
          [],
          failures.length > 0 ? failures.join("|") : "candidate-bank-no-valid-candidate",
        ),
      };
    }

    return {
      status: "rejected",
      pattern: fallback,
      diagnostics: diagnosticsFor(
        fallback,
        [],
        [],
        [...failures, ...invariantErrors(fallbackReport)],
        "fallback-failed-invariant-gate",
      ),
    };
  }

  async generate(plan: GenerationPlan, context: GenerationContext, signal?: AbortSignal): Promise<GenerationProposal> {
    if (signal?.aborted) throw new DOMException("Generation aborted", "AbortError");
    // Model ranking (goal doc Fáze 4) requires the async worker path; the
    // synchronous command path keeps the heuristic ranking.
    const mode = rankerMode();
    if (mode === "off" || (plan.candidateSeeds.length <= 1 && !((plan.options.candidateCount ?? 0) > 1))) {
      return this.generateSync(plan, context);
    }
    const effectiveKey = plan.options.key ?? context.project.key;
    const { candidates, failures, candidateSeeds } = this.collectCandidates(plan, context);
    // A model-path defect (feature extraction, batch assembly) must never break
    // generation: fall back to the deterministic heuristic bank ranking, same
    // as a worker timeout or an invalid model response would.
    let ranked;
    try {
      ranked = await rankCandidatesWithModel(context.project, candidates, plan);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ranked = {
        order: rankCandidateBank(context.project, candidates),
        mode,
        source: "fallback" as const,
        modelScores: candidates.map(() => null),
        featureVersion: null,
        rankerVersion: null,
        modelHash: null,
        fallbackReason: `ranker-pipeline-error:${reason}`,
      };
    }

    if (ranked.order.length > 0) {
      const selected = ranked.order[0];
      const bankWarnings: string[] =
        candidateSeeds.length > 1
          ? [`candidate-bank-enabled`, `candidate-bank-selected:${selected.candidateIndex}`]
          : [];
      if (failures.length > 0) bankWarnings.push(...failures.map((failure) => `candidate-bank-skipped:${failure}`));
      // Ranker provenance + shadow diagnostics (goal doc Fáze 4).
      bankWarnings.push(
        ranked.mode === "shadow" ? `ranker-shadow:${ranked.source}` : `ranker:${ranked.source}:${ranked.mode}`,
      );
      if (ranked.source === "model" && ranked.modelHash) {
        bankWarnings.push(`ranker-model:${ranked.rankerVersion}:${ranked.modelHash.slice(0, 12)}`);
      }
      if (ranked.fallbackReason) bankWarnings.push(ranked.fallbackReason);
      const withProvenance: Pattern = {
        ...selected.pattern,
        generation: {
          ...selected.pattern.generation!,
          ranker: {
            featureVersion: ranked.featureVersion ?? "features.v1",
            rankerVersion: ranked.rankerVersion ?? "unavailable",
            modelHash: ranked.modelHash,
            selectedIndex: selected.candidateIndex,
            mode: ranked.mode === "active" ? "active" : "shadow",
            source: ranked.source === "model" ? "model" : "fallback",
          },
        },
      };
      return {
        status: selected.status,
        pattern: withProvenance,
        diagnostics: diagnosticsFor(withProvenance, selected.repairs, bankWarnings),
      };
    }

    const fallback = attachProvenance(createFallbackPattern(context.project, plan.options), plan, context.project);
    const fallbackReport = inspectPatternInvariants(context.project, fallback, {
      checkScale: Boolean(effectiveKey),
      key: effectiveKey,
    });
    if (fallbackReport.ok) {
      return {
        status: "fallback",
        pattern: fallback,
        diagnostics: diagnosticsFor(
          fallback,
          [],
          ["local-generator-fallback", ...failures],
          [],
          failures.length > 0 ? failures.join("|") : "candidate-bank-no-valid-candidate",
        ),
      };
    }
    return {
      status: "rejected",
      pattern: fallback,
      diagnostics: diagnosticsFor(
        fallback,
        [],
        [],
        [...failures, ...invariantErrors(fallbackReport)],
        "fallback-failed-invariant-gate",
      ),
    };
  }
}

export const localDeterministicProvider = new LocalDeterministicProvider();
