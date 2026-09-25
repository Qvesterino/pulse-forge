import { generatePattern } from "../ai/generator";
import { inspectPatternInvariants } from "../ai/invariants";
import { normalizeIntent } from "./normalize";
import { planGeneration } from "./plan";
import { refreshPatternQuality } from "./quality";
import { extractPatternFeatures } from "../ai/features/pattern-features";
import { rankCandidateBank, type CandidateBankEntry } from "./candidate-bank";
import { createDefaultProject } from "../project-model/schema";
import type { GenerationPlan, IntentSpec } from "./types";
import type { Pattern, ProjectDocument } from "../project-model/types";
import type { FavoritesPack } from "./favorites";

/**
 * Favorites pack → intent-ranker preference groups (INTENT_ENGINE.md C2).
 *
 * A favourite is a PAIRWISE PREFERENCE: the roll the user kept is better than
 * what the same intent would otherwise offer. This module reconstructs that
 * comparison deterministically — for every ledger entry it rebuilds the exact
 * intent (all controls are recorded) and generates the favourite's pattern
 * PLUS same-intent sibling rolls (derived seeds); the favourite is labeled
 * the group winner.
 *
 * Output uses the intent-ranker dataset schema (groups with candidates that
 * carry features.v1 vectors + heuristic scores), so
 * `train-intent-ranker.py --favorites` folds it in without any format
 * bridging: the favourite's label becomes 1.0 in the trainer, negatives keep
 * their heuristic scores, favorite groups are TRAIN-only and oversampled.
 *
 * Lives in src (not scripts/) so vitest + tsc cover it like any engine code;
 * scripts/generate-intent-ranker-favorites.mts is the thin CLI on top.
 */

const NEGATIVE_SIBLINGS = 3;

/** Mirror of the dataset script's candidate gate (attach + hard invariants). */
function evaluateCandidate(doc: ProjectDocument, candidate: Pattern, plan: GenerationPlan): Pattern | null {
  const effectiveKey = plan.options.key ?? doc.key;
  const generation = candidate.generation ?? plan.recipe;
  const attached: Pattern = {
    ...candidate,
    generation: { ...generation, intentHash: plan.intentHash },
  };
  const report = inspectPatternInvariants(doc, attached, {
    checkScale: Boolean(effectiveKey),
    key: effectiveKey,
  });
  if (report.ok) return attached;
  return null;
}

export interface RankerFavoriteGroups {
  datasetVersion: string;
  featureVersion: string;
  sourceEntries: number;
  skippedEntries: number;
  groupCount: number;
  groups: Array<Record<string, unknown>>;
}

/** Build preference groups from a favorites pack (see file header). */
export function buildFavoriteRankerGroups(pack: FavoritesPack): RankerFavoriteGroups {
  const doc = createDefaultProject();
  const groups: Array<Record<string, unknown>> = [];
  let skipped = 0;

  for (const entry of pack.entries) {
    const style = entry.style ?? (entry.grooveId.includes(".") ? entry.grooveId.split(".")[1] : undefined);
    const intent: IntentSpec = normalizeIntent({
      genre: entry.genre,
      style: style || undefined,
      seed: entry.seed,
      length: entry.length ?? 16,
      energy: entry.energy,
      density: entry.density,
      complexity: entry.complexity,
      variation: entry.variation,
      controls: {
        ghostWeight: entry.ghostWeight,
        microWeight: entry.microWeight,
        velocityVariation: entry.velocityVariation,
        temperature: entry.temperature,
      },
    });
    const plan = planGeneration(intent, doc);

    const seeds = [
      entry.seed,
      ...Array.from({ length: NEGATIVE_SIBLINGS }, (_, i) => `${entry.seed}|rejected:${i + 1}`),
    ];
    const candidates: CandidateBankEntry[] = [];
    for (const [candidateIndex, seed] of seeds.entries()) {
      const options = { ...plan.options, seed };
      try {
        const pattern = generatePattern(doc, options);
        const attached = evaluateCandidate(doc, pattern, { ...plan, options, recipe: { ...plan.recipe, seed } });
        if (!attached) continue;
        const evaluated = {
          pattern: refreshPatternQuality(doc, attached, options),
          status: "accepted" as const,
          repairs: [],
        };
        candidates.push({
          candidateIndex,
          seed,
          pattern: evaluated.pattern,
          status: evaluated.status,
          repairs: evaluated.repairs,
          score: 0,
          contentHash: "",
        });
      } catch {
        /* candidate skipped — the bank just shrinks */
      }
    }
    if (candidates.length < 2 || candidates[0].seed !== entry.seed) {
      skipped += 1;
      continue;
    }

    const ordered = rankCandidateBank(doc, candidates);
    const features = ordered.map((bankEntry) =>
      extractPatternFeatures({
        doc,
        pattern: bankEntry.pattern,
        intent: plan.intent,
        options: plan.options,
        resolvedBpm: plan.resolvedBpm,
        batch: ordered.map((orderedEntry) => orderedEntry.pattern),
      }),
    );
    // The favourite's POSITION in the heuristic order — the trainer labels the
    // winner by this index (not by seed), so it must be resolved here.
    const winnerIndex = ordered.findIndex((bankEntry) => bankEntry.seed === entry.seed);
    if (winnerIndex < 0) {
      skipped += 1;
      continue;
    }

    groups.push({
      groupKey: `favorite:${entry.genre}:${entry.grooveId}:${entry.seed}`.slice(0, 180),
      favorite: true,
      winnerIndex,
      genre: entry.genre,
      style: entry.grooveId,
      seed: entry.seed,
      candidates: ordered.map((bankEntry, index) => {
        const isFavorite = index === winnerIndex;
        return {
          index,
          seed: bankEntry.seed,
          status: bankEntry.status,
          // The favourite's heuristic score is REPLACED by the preference
          // label (1.0) at training time via winnerIndex — recorded here as a
          // margin above everything else for tooling that reads raw files.
          heuristicScore: isFavorite ? 1 : bankEntry.score,
          favorite: isFavorite,
          features: Array.from(features[index].values),
        };
      }),
    });
  }

  return {
    datasetVersion: "intent-ranker-favorites.v1",
    featureVersion: "features.v1",
    sourceEntries: pack.entries.length,
    skippedEntries: skipped,
    groupCount: groups.length,
    // NOTE: "groups" must be the ARRAY — train-intent-ranker.py --favorites
    // reads payload["groups"] directly.
    groups,
  };
}
