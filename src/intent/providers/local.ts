import { generatePattern } from "../../ai/generator";
import { LOCAL_ENGINE_ID, LOCAL_ENGINE_VERSION } from "../../ai/evaluation";
import { extractPatternFeatures, FEATURE_NAMES } from "../../ai/features/pattern-features";
import type { GenerateOptions } from "../../ai/types";
import type { Pattern, ProjectDocument } from "../../project-model/types";
import { rankCandidateBank, type CandidateBankEntry } from "../candidate-bank";
import { rankCandidatesWithModel } from "../../ai/ranking/rank-candidates";
import { rankerMode } from "../../ai/ranking/ranker-client";
import { symbolicPriorProvider, symbolicWanted } from "./symbolic";
import { createFallbackPattern } from "../quality";
import {
  applyCandidateSearchFamily,
  candidateSearchVariant,
  selectPersonalGrooveCandidate,
  type CandidateSearchVariant,
} from "../candidate-search";
import { isPreferenceLearningEnabled, preferenceContextForIntent, readPreferenceLedger } from "../preference-ledger";
import { inferPersonalSearchBias } from "../personal-ranker";
import type {
  GenerationContext,
  GenerationDiagnostics,
  GenerationPlan,
  GenerationProposal,
  GenerationProvider,
  GenerationRanked,
  RankerSelectionMeta,
} from "../types";

type PatternGenerator = (doc: ProjectDocument, options: GenerateOptions) => Pattern;
const SYNCOPATION_FEATURE_INDEX = FEATURE_NAMES.indexOf("drums.syncopation");

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

import { attachProvenance, candidatePlan, evaluateCandidate } from "./candidate";

export { attachProvenance, candidatePlan, evaluateCandidate, invariantErrors } from "./candidate";

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
    searchLanes = false,
  ): {
    candidates: CandidateBankEntry[];
    failures: string[];
    candidateSeeds: readonly string[];
    safeSyncopation: number | null;
  } {
    const candidates: CandidateBankEntry[] = [];
    const failures: string[] = [];
    const candidateSeeds = plan.candidateSeeds.length > 0 ? plan.candidateSeeds : [plan.options.seed];
    const personalBias =
      searchLanes && isPreferenceLearningEnabled()
        ? inferPersonalSearchBias(readPreferenceLedger(), preferenceContextForIntent(plan.intent))
        : null;
    let safeSyncopation: number | null = null;

    const buildCandidate = (
      candidateIndex: number,
      seed: string,
      variant: CandidateSearchVariant | null,
    ): { candidate: CandidateBankEntry | null; syncopation: number | null; failure?: string } => {
      const validationPlan = variant?.validationPlan ?? candidatePlan(plan, seed);
      const generationPlan = variant?.generationPlan ?? validationPlan;
      const reasons: string[] = [];
      try {
        const generated = this.generator(context.project, generationPlan.options);
        const prepared = variant
          ? applyCandidateSearchFamily(generated, context.project, generationPlan, variant.search)
          : { pattern: generated, search: undefined };
        const evaluated = evaluateCandidate(prepared.pattern, validationPlan, context, reasons);
        if (!evaluated) {
          return {
            candidate: null,
            syncopation: null,
            failure: `candidate-${candidateIndex}:${reasons.length > 0 ? reasons.join("+") : "invariant-gate"}`,
          };
        }

        const candidate: CandidateBankEntry = {
          candidateIndex,
          seed: generationPlan.options.seed,
          pattern: evaluated.pattern,
          status: evaluated.status,
          repairs: evaluated.repairs,
          score: 0,
          contentHash: "",
          ...(prepared.search ? { search: prepared.search } : {}),
        };
        const needsSyncopationMeasurement =
          variant?.search.lane === "safe" || variant?.search.family === "personal-groove";
        const feature =
          needsSyncopationMeasurement && SYNCOPATION_FEATURE_INDEX >= 0
            ? extractPatternFeatures({
                doc: context.project,
                pattern: evaluated.pattern,
                intent: validationPlan.intent,
                options: generationPlan.options,
                resolvedBpm: validationPlan.resolvedBpm,
              }).values[SYNCOPATION_FEATURE_INDEX]
            : undefined;
        return {
          candidate,
          syncopation: typeof feature === "number" && Number.isFinite(feature) ? feature : null,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { candidate: null, syncopation: null, failure: `candidate-${candidateIndex}:generator-error:${reason}` };
      }
    };

    for (const [candidateIndex, seed] of candidateSeeds.entries()) {
      const variant = searchLanes ? candidateSearchVariant(plan, seed, candidateIndex, personalBias) : null;
      if (variant?.search.family === "personal-groove" && personalBias) {
        if (safeSyncopation === null) {
          failures.push(`candidate-${candidateIndex}:personal-groove-missing-safe-measurement`);
          continue;
        }
        const selection = selectPersonalGrooveCandidate({
          plan,
          seed,
          candidateIndex,
          personalBias,
          baselineSyncopation: safeSyncopation,
          build: (attemptVariant) => {
            const result = buildCandidate(candidateIndex, seed, attemptVariant);
            return result.candidate && result.syncopation !== null
              ? { candidate: result.candidate, syncopation: result.syncopation }
              : null;
          },
        });
        if (!selection.candidate || selection.outputDelta === null) {
          failures.push(`candidate-${candidateIndex}:personal-groove-direction-not-realized:${selection.attempts}`);
          continue;
        }
        candidates.push({
          ...selection.candidate,
          search: {
            ...selection.variant.search,
            measuredSyncopationDelta: selection.outputDelta * Math.sign(personalBias.grooveSyncopation),
            grooveSeedAttempts: selection.attempts,
          },
        });
        continue;
      }

      const result = buildCandidate(candidateIndex, seed, variant);
      if (!result.candidate) {
        failures.push(result.failure ?? `candidate-${candidateIndex}:invariant-gate`);
        continue;
      }
      candidates.push(result.candidate);
      if (candidateIndex === 0 && variant?.search.lane === "safe") safeSyncopation = result.syncopation;
    }
    return { candidates, failures, candidateSeeds, safeSyncopation };
  }

  generateSync(plan: GenerationPlan, context: GenerationContext): GenerationProposal {
    const { candidates, failures, candidateSeeds } = this.collectCandidates(plan, context);

    const ranked = rankCandidateBank(context.project, candidates);
    if (ranked.length > 0) {
      const selected = ranked[0];
      const bankWarnings =
        candidateSeeds.length > 1
          ? [
              `candidate-bank-enabled`,
              `candidate-bank-selected:${selected.candidateIndex}:${selected.source ?? "template"}`,
            ]
          : [];
      if (failures.length > 0) bankWarnings.push(...failures.map((failure) => `candidate-bank-skipped:${failure}`));
      return {
        status: selected.status,
        pattern: selected.pattern,
        diagnostics: diagnosticsFor(selected.pattern, selected.repairs, bankWarnings),
      };
    }

    const fallbackCandidate = createFallbackPattern(context.project, plan.options);
    const fallbackFailures = [...failures];
    const evaluatedFallback = evaluateCandidate(fallbackCandidate, plan, context, fallbackFailures);
    const fallback = evaluatedFallback?.pattern ?? attachProvenance(fallbackCandidate, plan, context.project);
    if (evaluatedFallback) {
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
      diagnostics: diagnosticsFor(fallback, [], [], fallbackFailures, "fallback-failed-invariant-or-preserve-gate"),
    };
  }

  /**
   * Full ranking run (A1 candidate audition): the winning proposal PLUS the
   * whole ranked bank and selection provenance, so the UI can audition every
   * candidate and apply any of them with truthful provenance.
   */
  async generateRanked(
    plan: GenerationPlan,
    context: GenerationContext,
    signal?: AbortSignal,
    searchLanes = true,
  ): Promise<GenerationRanked> {
    if (signal?.aborted) throw new DOMException("Generation aborted", "AbortError");
    // Genuinely single-candidate plans have no bank to rank — take the sync
    // fast path. NOTE: ranker mode "off" deliberately does NOT short-circuit:
    // audition needs the heuristic-ranked bank, and rankCandidatesWithModel
    // degrades to exactly that when the model is off.
    const symbolic = symbolicWanted(plan);
    if (!symbolic && plan.candidateSeeds.length <= 1 && !((plan.options.candidateCount ?? 0) > 1)) {
      return {
        proposal: this.generateSync(plan, context),
        ranked: [],
        modelScores: [],
        ranker: {
          featureVersion: "features.v1",
          rankerVersion: "unavailable",
          modelHash: null,
          mode: "shadow",
          source: "fallback",
        },
      };
    }
    const {
      candidates: templateCandidates,
      failures,
      candidateSeeds,
      safeSyncopation,
    } = this.collectCandidates(plan, context, searchLanes);
    // Symbolic-prior candidates (T2): sampled from the ONNX drum prior, they
    // enter the SAME bank and cross the SAME invariant/repair/ranking gates.
    // Every failure path only SHRINKS the bank — generation never blocks on
    // the prior.
    let candidates = templateCandidates;
    if (symbolic) {
      const collected = await symbolicPriorProvider.collectCandidates(
        plan,
        context,
        candidateSeeds.length,
        searchLanes,
        safeSyncopation,
      );
      if (collected.entries.length > 0) {
        candidates = [...templateCandidates, ...collected.entries];
      }
      if (collected.failures.length > 0) {
        failures.push(...collected.failures.map((failure) => `symbolic-prior:${failure}`));
      }
    }
    // A model-path defect (feature extraction, batch assembly) must never break
    // generation: fall back to the deterministic heuristic bank ranking, same
    // as a worker timeout or an invalid model response would.
    const mode = rankerMode();
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

    const rankerMeta: RankerSelectionMeta = {
      featureVersion: ranked.featureVersion ?? "features.v1",
      rankerVersion: ranked.rankerVersion ?? "unavailable",
      modelHash: ranked.modelHash,
      mode: ranked.mode,
      source: ranked.source === "model" ? "model" : "fallback",
    };

    if (ranked.order.length > 0) {
      const selected = ranked.order[0];
      const bankWarnings: string[] = [];
      if (candidateSeeds.length > 1 || candidates.length > candidateSeeds.length) {
        bankWarnings.push(`candidate-bank-enabled`);
        bankWarnings.push(`candidate-bank-selected:${selected.candidateIndex}:${selected.source ?? "template"}`);
      }
      if (candidates.length > templateCandidates.length) {
        bankWarnings.push(`symbolic-prior-candidates:${candidates.length - templateCandidates.length}`);
      }
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
          // Ranker-mode "off" keeps the historical contract: NO ranker
          // provenance on the pattern (heuristic generation only). Shadow /
          // active always record how the default winner was chosen.
          ...(ranked.mode !== "off"
            ? {
                ranker: {
                  featureVersion: rankerMeta.featureVersion,
                  rankerVersion: rankerMeta.rankerVersion,
                  modelHash: rankerMeta.modelHash,
                  selectedIndex: selected.candidateIndex,
                  mode: rankerMeta.mode === "active" ? "active" : "shadow",
                  source: rankerMeta.source,
                },
              }
            : {}),
        },
      };
      return {
        proposal: {
          status: selected.status,
          pattern: withProvenance,
          diagnostics: diagnosticsFor(withProvenance, selected.repairs, bankWarnings),
        },
        // The winner entry is replaced by its provenance-stamped version so
        // `result.proposal.pattern` IS `bank[0].pattern` (audition identity).
        ranked: ranked.order.map((entry, index) => (index === 0 ? { ...entry, pattern: withProvenance } : entry)),
        modelScores: ranked.modelScores,
        ranker: rankerMeta,
      };
    }

    const fallbackCandidate = createFallbackPattern(context.project, plan.options);
    const fallbackFailures = [...failures];
    const evaluatedFallback = evaluateCandidate(fallbackCandidate, plan, context, fallbackFailures);
    const fallback = evaluatedFallback?.pattern ?? attachProvenance(fallbackCandidate, plan, context.project);
    if (evaluatedFallback) {
      return {
        proposal: {
          status: "fallback",
          pattern: fallback,
          diagnostics: diagnosticsFor(
            fallback,
            [],
            ["local-generator-fallback", ...failures],
            [],
            failures.length > 0 ? failures.join("|") : "candidate-bank-no-valid-candidate",
          ),
        },
        ranked: [],
        modelScores: ranked.modelScores,
        ranker: rankerMeta,
      };
    }
    return {
      proposal: {
        status: "rejected",
        pattern: fallback,
        diagnostics: diagnosticsFor(fallback, [], [], fallbackFailures, "fallback-failed-invariant-or-preserve-gate"),
      },
      ranked: [],
      modelScores: ranked.modelScores,
      ranker: rankerMeta,
    };
  }

  async generate(plan: GenerationPlan, context: GenerationContext, signal?: AbortSignal): Promise<GenerationProposal> {
    // The compact non-audition path preserves legacy one-click behavior. The
    // SAFE/PERSONAL/EXPERIMENTAL search is reserved for the explicit bank UI.
    const { proposal } = await this.generateRanked(plan, context, signal, false);
    return proposal;
  }
}

export const localDeterministicProvider = new LocalDeterministicProvider();
