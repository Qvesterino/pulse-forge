import { generatePattern } from "../../ai/generator";
import { inspectPatternInvariants } from "../../ai/invariants";
import { LOCAL_ENGINE_ID, LOCAL_ENGINE_VERSION } from "../../ai/evaluation";
import type { GenerateOptions } from "../../ai/types";
import type { Pattern, ProjectDocument } from "../../project-model/types";
import { createFallbackPattern, repairGeneratedPattern, refreshPatternOutputHash } from "../quality";
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
    },
  });
}

function invariantErrors(report: ReturnType<typeof inspectPatternInvariants>): string[] {
  return report.issues.map((issue) => `invariant:${issue.code}`);
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
    let candidate: Pattern;
    try {
      candidate = this.generator(context.project, plan.options);
    } catch (error) {
      const fallback = attachProvenance(createFallbackPattern(context.project, plan.options), plan, context.project);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: "fallback",
        pattern: fallback,
        diagnostics: diagnosticsFor(fallback, [], ["local-generator-fallback"], [], `generator-error:${reason}`),
      };
    }

    const candidateWithProvenance = attachProvenance(candidate, plan, context.project);
    const candidateReport = inspectPatternInvariants(context.project, candidateWithProvenance, {
      checkScale: Boolean(effectiveKey),
      key: effectiveKey,
    });
    if (candidateReport.ok) {
      return {
        status: "accepted",
        pattern: candidateWithProvenance,
        diagnostics: diagnosticsFor(candidateWithProvenance),
      };
    }

    const repaired = repairGeneratedPattern(
      context.project,
      candidateWithProvenance,
      plan.options.stepCount,
      effectiveKey,
    );
    const repairedWithProvenance = attachProvenance(repaired.pattern, plan, context.project);
    const repairedReport = inspectPatternInvariants(context.project, repairedWithProvenance, {
      checkScale: Boolean(effectiveKey),
      key: effectiveKey,
    });
    if (repairedReport.ok) {
      return {
        status: "repaired",
        pattern: repairedWithProvenance,
        diagnostics: diagnosticsFor(
          repairedWithProvenance,
          repaired.repairs.length > 0 ? repaired.repairs : invariantErrors(candidateReport),
          ["local-generator-repaired"],
        ),
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
          ["local-generator-fallback", ...invariantErrors(candidateReport), ...invariantErrors(repairedReport)],
          [],
          "candidate-and-repair-failed-invariant-gate",
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
        [...invariantErrors(candidateReport), ...invariantErrors(repairedReport), ...invariantErrors(fallbackReport)],
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
