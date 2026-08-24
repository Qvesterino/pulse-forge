import { DEFAULT_GENERATE_OPTIONS, GENRES, type GenerateOptions } from "../ai/types";
import { isMusicalKey } from "../project-model/types";
import { INTENT_SCHEMA_VERSION, type IntentInput, type IntentRole, type IntentSpec } from "./types";
import { assertIntentSpec } from "./schema";

const DEFAULT_ROLES: readonly IntentRole[] = ["drums", "bass", "chords", "lead"];

function unit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function lengthOf(value: unknown, fallback: number): number {
  const raw = finite(value, fallback);
  return Math.max(16, Math.min(256, Math.round(raw / 16) * 16));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function rolesOf(value: unknown): IntentRole[] {
  if (!Array.isArray(value)) return [...DEFAULT_ROLES];
  const roles = value.filter((role): role is IntentRole =>
    role === "drums" || role === "bass" || role === "chords" || role === "lead",
  );
  return roles.length > 0 ? [...new Set(roles)] : [...DEFAULT_ROLES];
}

function bpmRangeOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const values = value.map((item) => Math.max(20, Math.min(300, finite(item, 120))));
  return [Math.min(values[0], values[1]), Math.max(values[0], values[1])];
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Normalize untrusted user/provider data into one canonical IntentSpec. */
export function normalizeIntent(input: IntentInput | unknown = {}): IntentSpec {
  const source = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const controls = source.controls && typeof source.controls === "object"
    ? source.controls as Record<string, unknown>
    : {};
  const targetTracks = source.targetTracks && typeof source.targetTracks === "object"
    ? source.targetTracks as Record<string, unknown>
    : {};
  const constraints = source.constraints && typeof source.constraints === "object"
    ? source.constraints as Record<string, unknown>
    : {};
  const genre = GENRES.includes(source.genre as typeof GENRES[number])
    ? source.genre as GenerateOptions["genre"]
    : DEFAULT_GENERATE_OPTIONS.genre;
  const normalized: IntentSpec = {
    version: INTENT_SCHEMA_VERSION,
    genre,
    style: text(source.style),
    mood: text(source.mood),
    energy: unit(source.energy, 0.7),
    density: unit(source.density, 0.5),
    complexity: unit(source.complexity, 0.5),
    variation: unit(source.variation, DEFAULT_GENERATE_OPTIONS.velocityVariation),
    seed: typeof source.seed === "string" ? source.seed.slice(0, 128) : DEFAULT_GENERATE_OPTIONS.seed,
    key: isMusicalKey(source.key) ? source.key : null,
    bpmRange: bpmRangeOf(source.bpmRange),
    length: lengthOf(source.length, DEFAULT_GENERATE_OPTIONS.stepCount),
    roles: rolesOf(source.roles),
    targetTracks: {
      drumTrackId: typeof targetTracks.drumTrackId === "string" && targetTracks.drumTrackId.length > 0
        ? targetTracks.drumTrackId
        : null,
      instrumentTrackIds: stringList(targetTracks.instrumentTrackIds),
    },
    constraints: {
      preserveAnchors: bool(constraints.preserveAnchors, true),
      allowGhosts: bool(constraints.allowGhosts, true),
      allowSwing: bool(constraints.allowSwing, true),
    },
    controls: {
      ghostWeight: unit(controls.ghostWeight, DEFAULT_GENERATE_OPTIONS.ghostWeight),
      microWeight: unit(controls.microWeight, DEFAULT_GENERATE_OPTIONS.microWeight),
      velocityVariation: unit(controls.velocityVariation, DEFAULT_GENERATE_OPTIONS.velocityVariation),
      temperature: Math.max(0.2, Math.min(2, finite(controls.temperature, DEFAULT_GENERATE_OPTIONS.temperature))),
    },
    sourcePatternId: typeof source.sourcePatternId === "string" && source.sourcePatternId.length > 0
      ? source.sourcePatternId
      : null,
    replaceMode: source.replaceMode === "replace" ? "replace" : "new",
    applyGrooveSettings: bool(source.applyGrooveSettings, false),
  };
  assertIntentSpec(normalized);
  return normalized;
}

export function intentFromGenerateOptions(options: GenerateOptions): IntentSpec {
  return normalizeIntent({
    genre: options.genre,
    style: options.style,
    seed: options.seed,
    length: options.stepCount,
    variation: options.velocityVariation,
    controls: {
      ghostWeight: options.ghostWeight,
      microWeight: options.microWeight,
      velocityVariation: options.velocityVariation,
      temperature: options.temperature,
    },
    targetTracks: {
      drumTrackId: options.drumTrackId ?? null,
      instrumentTrackIds: options.instrumentTrackIds ?? [],
    },
    sourcePatternId: options.sourcePatternId ?? null,
    replaceMode: options.replaceMode,
    applyGrooveSettings: options.applyGrooveSettings ?? false,
  });
}
