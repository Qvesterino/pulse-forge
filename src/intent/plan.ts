import type { ProjectDocument } from "../project-model/types";
import { drumTrackForTarget, instrumentTargets, instrumentTrackForRole } from "../ai/role-targets";
import { forkRandom } from "../shared/rng";
import { createGenerationRecipe } from "../ai/evaluation";
import { resolveEffectiveSeed, resolveGrooveForGeneration, sourcePatternContentHash } from "../ai/generator";
import type { GenerateOptions } from "../ai/types";
import { intentHash } from "./hash";
import { normalizeIntent } from "./normalize";
import { mapIntentToOptions } from "./mapping";
import type { GenerationPlan, IntentInput, IntentRole, IntentSpec } from "./types";

export function generateOptionsFromIntent(intent: IntentSpec): GenerateOptions {
  // Protected roles never reach the generator: "keep my bass" means the
  // bass content in the project survives this generation untouched, even
  // when `roles` still lists the role.
  const preserved = intent.preserve ?? [];
  const base: GenerateOptions = {
    genre: intent.genre,
    style: intent.style ?? undefined,
    productionProfile: intent.productionProfile,
    seed: intent.seed,
    stepCount: intent.length,
    key: intent.key,
    bpmRange: intent.bpmRange,
    candidateCount: intent.candidateCount ?? 1,
    roles: intent.roles.filter((role) => !preserved.includes(role)),
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
  const preserveSourcePatternId =
    intent.preserve && intent.preserve.length > 0
      ? (intent.sourcePatternId ??
        (doc.patterns.some((pattern) => pattern.id === doc.activePatternId) ? doc.activePatternId : null))
      : undefined;
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
  const resolvedDrumTrackId = drumTrackForTarget(doc, intent.targetTracks.drumTrackId ?? undefined)?.id ?? null;
  const resolvedInstrumentTrackIds = instrumentTargets(doc, intent.targetTracks.instrumentTrackIds).map(
    (track) => track.id,
  );
  const preserved = intent.preserve ?? [];
  const hasValidInstrumentTarget =
    intent.targetTracks.instrumentTrackIds.length === 0 || resolvedInstrumentTrackIds.length > 0;
  const instrumentScope = intent.targetTracks.instrumentTrackIds.length > 0 ? resolvedInstrumentTrackIds : undefined;
  const bassTrack = hasValidInstrumentTarget ? instrumentTrackForRole(doc, "bass", instrumentScope) : null;
  const chordTrack = hasValidInstrumentTarget ? instrumentTrackForRole(doc, "chord", instrumentScope) : null;
  const leadTrack = hasValidInstrumentTarget ? instrumentTrackForRole(doc, "lead", instrumentScope) : null;
  const resolvedRoleTracks: Record<IntentRole, readonly string[]> = {
    drums: resolvedDrumTrackId ? [resolvedDrumTrackId] : [],
    bass: bassTrack ? [bassTrack.id] : [],
    chords: chordTrack ? [chordTrack.id] : [],
    lead: leadTrack ? [leadTrack.id] : [],
  };
  const rolePlans = Object.fromEntries(
    (
      [
        ["drums", resolvedRoleTracks.drums],
        ["bass", resolvedRoleTracks.bass],
        ["chords", resolvedRoleTracks.chords],
        ["lead", resolvedRoleTracks.lead],
      ] as const
    ).map(([role, targetTrackIds]) => [
      role,
      {
        enabled: intent.roles.includes(role as IntentRole) && !preserved.includes(role as IntentRole),
        targetTrackIds:
          intent.roles.includes(role as IntentRole) && !preserved.includes(role as IntentRole) ? targetTrackIds : [],
      },
    ]),
  ) as GenerationPlan["rolePlans"];
  return {
    intent,
    options,
    ...(preserveSourcePatternId !== undefined ? { preserveSourcePatternId } : {}),
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
