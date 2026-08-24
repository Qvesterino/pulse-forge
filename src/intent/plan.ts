import type { ProjectDocument } from "../project-model/types";
import { forkRandom } from "../shared/rng";
import { createGenerationRecipe } from "../ai/evaluation";
import { resolveEffectiveSeed, resolveGrooveForGeneration, sourcePatternContentHash } from "../ai/generator";
import type { GenerateOptions } from "../ai/types";
import { intentHash } from "./hash";
import { normalizeIntent } from "./normalize";
import type { GenerationPlan, IntentInput, IntentRole, IntentSpec } from "./types";

export function generateOptionsFromIntent(intent: IntentSpec): GenerateOptions {
  return {
    genre: intent.genre,
    style: intent.style ?? undefined,
    seed: intent.seed,
    stepCount: intent.length,
    ghostWeight: intent.controls.ghostWeight,
    microWeight: intent.controls.microWeight,
    velocityVariation: intent.controls.velocityVariation,
    temperature: intent.controls.temperature,
    replaceMode: intent.replaceMode,
    drumTrackId: intent.targetTracks.drumTrackId ?? undefined,
    instrumentTrackIds: intent.targetTracks.instrumentTrackIds.length > 0
      ? [...intent.targetTracks.instrumentTrackIds]
      : undefined,
    sourcePatternId: intent.sourcePatternId ?? undefined,
    applyGrooveSettings: intent.applyGrooveSettings,
  };
}

function generationSeed(intent: IntentSpec, effectiveSeed: string, grooveId: string): string {
  return `${intent.genre}|${effectiveSeed}|${grooveId}`;
}

/** Pure, serializable plan shared by preview and apply. */
export function planGeneration(input: IntentInput | IntentSpec, doc: ProjectDocument): GenerationPlan {
  const intent = normalizeIntent(input);
  const options = generateOptionsFromIntent(intent);
  const effectiveSeed = resolveEffectiveSeed(doc, options);
  const groove = resolveGrooveForGeneration(doc, options);
  const inputContentHash = sourcePatternContentHash(doc, options.sourcePatternId);
  const seed = generationSeed(intent, effectiveSeed, groove.id);
  const recipe = createGenerationRecipe(options, groove.id, inputContentHash);
  const rolePlans = Object.fromEntries(([
    ["drums", intent.targetTracks.drumTrackId ? [intent.targetTracks.drumTrackId] : []],
    ["bass", [...intent.targetTracks.instrumentTrackIds]],
    ["chords", [...intent.targetTracks.instrumentTrackIds]],
    ["lead", [...intent.targetTracks.instrumentTrackIds]],
  ] as const).map(([role, targetTrackIds]) => [role, {
    enabled: intent.roles.includes(role as IntentRole),
    targetTrackIds,
  }])) as GenerationPlan["rolePlans"];
  return {
    intent,
    options,
    groove: {
      id: groove.id,
      genre: groove.genre,
      name: groove.name,
      bpm: groove.bpm,
      swing: groove.swing,
    },
    effectiveSeed,
    inputContentHash,
    intentHash: intentHash(intent),
    rolePlans,
    constraints: intent.constraints,
    subSeeds: {
      groove: `${seed}|groove`,
      drumsCore: `${seed}|drums.core`,
      drumsVariation: `${seed}|drums.variation`,
      drumsMeta: `${seed}|drums.meta`,
      melodyFallback: `${seed}|melody.fallback`,
      bass: `${seed}|melody.bass`,
      chord: `${seed}|melody.chord`,
      lead: `${seed}|melody.lead`,
    },
    outputShape: {
      stepCount: intent.length,
      roles: intent.roles,
      replaceMode: intent.replaceMode,
    },
    recipe,
  };
}

/** Expose deterministic stream objects for future providers without sharing mutable RNG state. */
export function planRandomStreams(plan: GenerationPlan): Record<string, () => number> {
  return Object.fromEntries(Object.entries(plan.subSeeds).map(([name, seed]) => [name, forkRandom(seed, "stream")])) as Record<string, () => number>;
}
