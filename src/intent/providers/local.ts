import { generatePattern } from "../../ai/generator";
import { inspectPatternInvariants } from "../../ai/invariants";
import { LOCAL_ENGINE_ID, LOCAL_ENGINE_VERSION } from "../../ai/evaluation";
import type { GenerateOptions } from "../../ai/types";
import type { Pattern, ProjectDocument } from "../../project-model/types";
import { rankCandidateBank, type CandidateBankEntry } from "../candidate-bank";
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

  generateSync(plan: GenerationPlan, context: GenerationContext): GenerationProposal {
    const effectiveKey = plan.options.key ?? context.project.key;
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
    return this.generateSync(plan, context);
  }
}

export const localDeterministicProvider = new LocalDeterministicProvider();
