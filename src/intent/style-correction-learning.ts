/**
 * Convert a settled, human pattern edit into a local pairwise preference.
 * The learner stores only feature vectors, coarse intent context and content
 * hashes; notes, prompts, names and project documents never enter the ledger.
 */
import { extractPatternFeaturesV2 } from "../ai/features/pattern-features-v2";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import type { Pattern, ProjectDocument } from "../project-model/types";
import {
  createPreferenceObservation,
  isPreferenceLearningEnabled,
  preferenceContextForIntent,
  recordPreferenceObservation,
} from "./preference-ledger";
import { planGeneration } from "./plan";
import { patternStyleExampleFromProject } from "./pattern-style-example";
import { preferredStyleGenre } from "./style-example-ledger";

const MIN_FEATURE_DELTA = 0.02;

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Treat the settled result as the preferred side of a comparison with its
 * pre-edit state. A content-only edit that the feature contract cannot see is
 * deliberately ignored, so it cannot inflate confidence without teaching a
 * measurable musical preference.
 */
export function learnFromPatternCorrection(
  beforeDoc: ProjectDocument,
  before: Pattern,
  afterDoc: ProjectDocument,
  after: Pattern,
): boolean {
  if (!isPreferenceLearningEnabled()) return false;
  try {
    // Building a pattern from silence teaches that music is preferable to an
    // empty clip, not what the user's style sounds like.
    if (!patternStyleExampleFromProject(beforeDoc, before, preferredStyleGenre())) return false;
    const style = patternStyleExampleFromProject(afterDoc, after, preferredStyleGenre());
    if (!style) return false;
    const rawIntent = plainObject(after.generation?.intent) ??
      plainObject(before.generation?.intent) ?? {
        genre: after.generation?.genre ?? before.generation?.genre ?? style.genre,
        length: after.stepCount,
        seed: "local-style-learning",
      };
    const plan = planGeneration(rawIntent, afterDoc);
    const batch = [before, after] as const;
    const featureInput = (doc: ProjectDocument, pattern: Pattern) =>
      extractPatternFeaturesV2({
        doc,
        pattern,
        intent: plan.intent,
        options: plan.options,
        resolvedBpm: plan.resolvedBpm,
        batch,
      }).values;
    const beforeFeatures = featureInput(beforeDoc, before);
    const afterFeatures = featureInput(afterDoc, after);
    if (beforeFeatures.length !== afterFeatures.length) return false;

    const featureDelta = beforeFeatures.reduce(
      (sum, value, index) => sum + Math.abs(value - (afterFeatures[index] ?? value)),
      0,
    );
    if (!Number.isFinite(featureDelta) || featureDelta < MIN_FEATURE_DELTA) return false;

    const context = preferenceContextForIntent(plan.intent);
    const observation = createPreferenceObservation(
      context,
      {
        contentHash: contentHash(canonicalizePattern(afterDoc, after)),
        features: afterFeatures,
      },
      {
        contentHash: contentHash(canonicalizePattern(beforeDoc, before)),
        features: beforeFeatures,
      },
      "a",
      { source: "edit" },
    );
    return observation ? recordPreferenceObservation(observation) : false;
  } catch {
    // Local learning is advisory and must never interrupt a user's edit.
    return false;
  }
}
