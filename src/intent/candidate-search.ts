import { generateOptionsFromIntent } from "./plan";
import { candidatePlan } from "./providers/candidate";
import type { GenerationPlan, IntentSpec } from "./types";
import type { PersonalSearchBias } from "./personal-ranker";

export type SearchLane = "safe" | "personal" | "experimental";

export interface CandidateSearchInfo {
  version: 1;
  lane: SearchLane;
  /** Personal lane without enough usable votes is explicitly cold-start. */
  mode: "baseline" | "personalized" | "cold-start" | "experimental";
  variant: number;
}

export interface CandidateSearchVariant {
  /** Plan used only to produce this candidate. */
  generationPlan: GenerationPlan;
  /** Original user intent + candidate seed; always used for gates/provenance. */
  validationPlan: GenerationPlan;
  search: CandidateSearchInfo;
}

const EXPERIMENTAL_VARIANTS = [
  { energy: 0.04, density: 0.15, complexity: 0.13, variation: 0.08 },
  { energy: -0.05, density: -0.14, complexity: 0.18, variation: 0.12 },
  { energy: 0.1, density: 0.07, complexity: -0.1, variation: 0.16 },
] as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function searchLaneForCandidate(candidateIndex: number): SearchLane {
  switch (Math.abs(Math.floor(candidateIndex)) % 3) {
    case 1:
      return "personal";
    case 2:
      return "experimental";
    default:
      return "safe";
  }
}

function withSoftIntent(
  intent: IntentSpec,
  delta: Pick<PersonalSearchBias, "energy" | "density" | "complexity" | "variation">,
): IntentSpec {
  return {
    ...intent,
    energy: clamp01(intent.energy + delta.energy),
    density: clamp01(intent.density + delta.density),
    complexity: clamp01(intent.complexity + delta.complexity),
    variation: clamp01(intent.variation + delta.variation),
  };
}

function withSearchSeed(plan: GenerationPlan, intent: IntentSpec, seed: string): GenerationPlan {
  const generationIntent = { ...intent, seed };
  const options = generateOptionsFromIntent(generationIntent);
  return {
    ...plan,
    intent: {
      ...generationIntent,
      controls: {
        ...generationIntent.controls,
        ghostWeight: options.ghostWeight,
        microWeight: options.microWeight,
        velocityVariation: options.velocityVariation,
        temperature: options.temperature,
      },
    },
    options: { ...options, seed, candidateCount: plan.options.candidateCount },
    recipe: { ...plan.recipe, seed },
  };
}

/**
 * Build a deterministic lane-specific generation plan while retaining a
 * separate unmodified plan for hard brief gates and truthful provenance.
 * Candidate 0 is deliberately byte-for-byte on the legacy SAFE path.
 */
export function candidateSearchVariant(
  plan: GenerationPlan,
  seed: string,
  candidateIndex: number,
  personalBias: PersonalSearchBias | null,
): CandidateSearchVariant {
  const lane = searchLaneForCandidate(candidateIndex);
  const variant = Math.floor(Math.abs(Math.floor(candidateIndex)) / 3);
  const validationPlan = candidatePlan(plan, seed);

  if (lane === "safe") {
    return {
      generationPlan: validationPlan,
      validationPlan,
      search: { version: 1, lane, mode: "baseline", variant },
    };
  }

  let delta: Pick<PersonalSearchBias, "energy" | "density" | "complexity" | "variation">;
  let mode: CandidateSearchInfo["mode"];
  if (lane === "personal") {
    delta = personalBias ?? { energy: 0, density: 0, complexity: 0, variation: 0 };
    mode = personalBias ? "personalized" : "cold-start";
  } else {
    delta = EXPERIMENTAL_VARIANTS[variant % EXPERIMENTAL_VARIANTS.length];
    mode = "experimental";
  }

  const intent = withSoftIntent(plan.intent, delta);
  const searchSeed = `${seed}|search:v1:${lane}:e${intent.energy.toFixed(2)}:d${intent.density.toFixed(2)}:c${intent.complexity.toFixed(2)}:v${intent.variation.toFixed(2)}`;
  return {
    generationPlan: withSearchSeed(validationPlan, intent, searchSeed),
    validationPlan,
    search: { version: 1, lane, mode, variant },
  };
}
