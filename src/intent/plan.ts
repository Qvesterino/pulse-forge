import type { ProjectDocument } from "../project-model/types";
import { forkRandom } from "../shared/rng";
import { createGenerationRecipe } from "../ai/evaluation";
import { resolveEffectiveSeed, resolveGrooveForGeneration, sourcePatternContentHash } from "../ai/generator";
import type { GenerateOptions } from "../ai/types";
import { intentHash } from "./hash";
import { normalizeIntent } from "./normalize";
import { mapIntentToOptions } from "./mapping";
import type { GenerationPlan, IntentInput, IntentRole, IntentSpec } from "./types";

export function generateOptionsFromIntent(intent: IntentSpec): GenerateOptions {
  const base: GenerateOptions = {
    genre: intent.genre,
    style: intent.style ?? undefined,
    seed: intent.seed,
    stepCount: intent.length,
    key: intent.key,
    bpmRange: intent.bpmRange,
    candidateCount: intent.candidateCount ?? 1,
    roles: intent.roles,
    constraints: intent.constraints,
    ghostWeight: intent.controls.ghostWeight,
    microWeight: intent.controls.microWeight,
    velocityVariation: intent.controls.velocityVariation,
    temperature: intent.controls.temperature,
    replaceMode: intent.replaceMode,
    drumTrackId: intent.targetTracks.drumTrackId ?? undefined,
    instrumentTrackIds:
      intent.targetTracks.instrumentTrackIds.length > 0 ? [...intent.targetTracks.instrumentTrackIds] : undefined,
    sourcePatternId: intent.sourcePatternId ?? undefined,
    applyGrooveSettings: intent.applyGrooveSettings,
  };
  return mapIntentToOptions(intent, base);
}

function resolveBpm(bpm: [number, number], requested: [number, number] | null): number | null {
  if (!requested) return null;
  const grooveMidpoint = (bpm[0] + bpm[1]) / 2;
  const clamped = Math.max(requested[0], Math.min(requested[1], grooveMidpoint));
  return Math.round(clamped * 10) / 10;
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
  const resolvedBpm = resolveBpm(groove.bpm, intent.bpmRange);
  const candidateSeeds = Array.from({ length: intent.candidateCount ?? 1 }, (_, index) =>
    index === 0 ? intent.seed : `${intent.seed}|candidate:${index}`,
  );
  const symbolicSeeds =
    (intent.symbolicCandidates ?? 0) > 0
      ? Array.from({ length: intent.symbolicCandidates ?? 0 }, (_, index) => `${intent.seed}|symbolic:${index}`)
      : [];
  const resolvedDrumTrackId =
    intent.targetTracks.drumTrackId ?? doc.tracks.find((track) => track.kind === "drum")?.id ?? null;
  const resolvedInstrumentTrackIds =
    intent.targetTracks.instrumentTrackIds.length > 0
      ? [...intent.targetTracks.instrumentTrackIds]
      : doc.tracks.filter((track) => track.kind === "instrument").map((track) => track.id);
  const rolePlans = Object.fromEntries(
    (
      [
        ["drums", resolvedDrumTrackId ? [resolvedDrumTrackId] : []],
        ["bass", [...resolvedInstrumentTrackIds]],
        ["chords", [...resolvedInstrumentTrackIds]],
        ["lead", [...resolvedInstrumentTrackIds]],
      ] as const
    ).map(([role, targetTrackIds]) => [
      role,
      {
        enabled: intent.roles.includes(role as IntentRole),
        targetTrackIds: intent.roles.includes(role as IntentRole) ? targetTrackIds : [],
      },
    ]),
  ) as GenerationPlan["rolePlans"];
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
    resolvedBpm,
    candidateSeeds,
    symbolicSeeds,
    subSeeds: {
      groove: `${seed}|groove`,
      drumsCore: `${seed}|drums.core`,
      drumsVariation: `${seed}|drums.variation`,
      drumsMeta: `${seed}|drums.meta`,
      drumsNeural: `${seed}|drums.neural`,
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
  return Object.fromEntries(
    Object.entries(plan.subSeeds).map(([name, seed]) => [name, forkRandom(seed, "stream")]),
  ) as Record<string, () => number>;
}
