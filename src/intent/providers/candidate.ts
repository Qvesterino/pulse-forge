import type { Pattern, ProjectDocument } from "../../project-model/types";
import { inspectPatternInvariants } from "../../ai/invariants";
import { refreshPatternOutputHash, refreshPatternQuality, repairGeneratedPattern } from "../quality";
import { briefGateViolations } from "../brief-gate";
import { preserveSourceContent } from "../preserved-content";
import type { GenerationContext, GenerationPlan } from "../types";

/**
 * Candidate-shaping helpers shared by the template provider (local.ts) and
 * the symbolic-prior provider (symbolic.ts), extracted into a leaf module so
 * the two providers do not import each other (GOAL 02, re-run 4): every
 * candidate in the bank crosses exactly the same gates (INTENT_ENGINE.md §9).
 */

export function attachProvenance(pattern: Pattern, plan: GenerationPlan, doc: ProjectDocument): Pattern {
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

export function invariantErrors(report: ReturnType<typeof inspectPatternInvariants>): string[] {
  return report.issues.map((issue) => `invariant:${issue.code}`);
}

export function candidatePlan(plan: GenerationPlan, seed: string): GenerationPlan {
  return {
    ...plan,
    options: { ...plan.options, seed },
    recipe: { ...plan.recipe, seed },
  };
}

/**
 * Shared candidate gate: attach provenance, run the hard invariants and —
 * when needed — the deterministic repair, then re-inspect. Fáza 2: after
 * the structural pass, the BRIEF hard gate drops any candidate whose
 * content still violates the plan (wrong length, all-silent, prohibited
 * drum content). Brief violations are appended to `reasons` so callers can
 * report `candidate-N:brief-gate:<id>` in the diagnostics.
 */
export function evaluateCandidate(
  candidate: Pattern,
  plan: GenerationPlan,
  context: GenerationContext,
  reasons?: string[],
): { pattern: Pattern; status: "accepted" | "repaired"; repairs: string[] } | null {
  const effectiveKey = plan.options.key ?? context.project.key;
  const attachPreserved = (pattern: Pattern): Pattern | null => {
    if (!plan.intent.preserve?.length) return attachProvenance(pattern, plan, context.project);
    const preserved = preserveSourceContent(pattern, plan, context.project);
    if (preserved.violations.length > 0) {
      for (const violation of preserved.violations) reasons?.push(`brief-gate:${violation.id}:${violation.detail}`);
      return null;
    }
    const measured = refreshPatternQuality(context.project, preserved.pattern, plan.options);
    return attachProvenance(measured, plan, context.project);
  };
  const finalizePreserved = (pattern: Pattern): Pattern | null => {
    if (!plan.intent.preserve?.length) return pattern;
    const preserved = preserveSourceContent(pattern, plan, context.project, { freshNoteIds: true });
    if (preserved.violations.length > 0) {
      for (const violation of preserved.violations) reasons?.push(`brief-gate:${violation.id}:${violation.detail}`);
      return null;
    }
    return attachProvenance(
      refreshPatternQuality(context.project, preserved.pattern, plan.options),
      plan,
      context.project,
    );
  };
  const attached = attachPreserved(candidate);
  if (!attached) return null;
  const report = inspectPatternInvariants(context.project, attached, {
    checkScale: Boolean(effectiveKey),
    key: effectiveKey,
  });
  if (report.ok) {
    const violations = briefGateViolations(attached, plan, { preservedRoles: plan.intent.preserve });
    if (violations.length > 0) {
      for (const violation of violations) reasons?.push(`brief-gate:${violation.id}`);
      return null;
    }
    const finalPattern = finalizePreserved(attached);
    return finalPattern ? { pattern: finalPattern, status: "accepted", repairs: [] } : null;
  }

  const repaired = repairGeneratedPattern(context.project, attached, plan.options.stepCount, effectiveKey);
  const repairedPattern = attachPreserved(repaired.pattern);
  if (!repairedPattern) return null;
  const repairedReport = inspectPatternInvariants(context.project, repairedPattern, {
    checkScale: Boolean(effectiveKey),
    key: effectiveKey,
  });
  if (!repairedReport.ok) return null;
  const violations = briefGateViolations(repairedPattern, plan, { preservedRoles: plan.intent.preserve });
  if (violations.length > 0) {
    for (const violation of violations) reasons?.push(`brief-gate:${violation.id}`);
    return null;
  }
  const finalPattern = finalizePreserved(repairedPattern);
  if (!finalPattern) return null;
  return {
    pattern: finalPattern,
    status: "repaired",
    repairs: repaired.repairs.length > 0 ? repaired.repairs : invariantErrors(report),
  };
}
