import { DEFAULT_GENERATE_OPTIONS, GENRES, type GenerateOptions } from "../ai/types";
import { isMusicalKey, PRODUCTION_PROFILES } from "../project-model/types";
import type { ProjectDocument, TimeSignature } from "../project-model/types";
import { DEFAULT_STEPS_PER_BAR, MAX_PATTERN_STEPS, stepsPerBar, stepsPerBarFor } from "../project-model/grid";
import { INTENT_SCHEMA_VERSION, type IntentInput, type IntentRole, type IntentSpec } from "./types";
import { assertIntentSpec } from "./schema";
import { sanitizeFxIntent } from "./production";

const DEFAULT_ROLES: readonly IntentRole[] = ["drums", "bass", "chords", "lead"];

/**
 * The REQUESTED meter, when the request names one (ADR 0057 Stage 2f).
 *
 * Untrusted input: only a well-formed signature survives. A broken one is
 * dropped (the request falls back to the document's meter) rather than
 * rejected — the same rule the rest of this module follows for bad values.
 */
function requestedMeter(value: unknown): TimeSignature | null {
  if (!value || typeof value !== "object") return null;
  const numerator = (value as { numerator?: unknown }).numerator;
  const denominator = (value as { denominator?: unknown }).denominator;
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) return null;
  if ((numerator as number) < 1 || (numerator as number) > 16) return null;
  if (![2, 4, 8, 16].includes(denominator as number)) return null;
  return { numerator: numerator as number, denominator: denominator as number };
}

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

/**
 * The requested length in steps, aligned to the document's BAR.
 *
 * The quantum is the bar, not a hard-coded sixteen. In 4/4 this is exactly
 * the legacy `round(raw / 16) * 16` — one bar is 16 steps there — and in 3/4
 * it rounds to twelfths. The result is always a whole number of bars, so a
 * generated pattern starts on the downbeat of the meter it was asked for.
 */
function lengthOf(value: unknown, perBar: number): number {
  const raw = finite(value, perBar);
  const maxBars = Math.max(1, Math.floor(MAX_PATTERN_STEPS / perBar));
  const bars = Math.max(1, Math.min(maxBars, Math.round(raw / perBar)));
  return bars * perBar;
}

/**
 * The requested length in BARS, or null when the request is not framed in
 * bars. Bars are meter-independent, so they survive the trip from the parser
 * to the document that finally decides how many steps one bar holds.
 */
function barsOf(value: unknown, perBar: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const maxBars = Math.max(1, Math.floor(MAX_PATTERN_STEPS / perBar));
  return Math.max(1, Math.min(maxBars, Math.round(value)));
}

function candidateCountOf(value: unknown): number {
  return Math.max(1, Math.min(8, Math.round(finite(value, 1))));
}

function symbolicCandidatesOf(value: unknown): number {
  return Math.max(0, Math.min(4, Math.round(finite(value, 0))));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function rolesOf(value: unknown): IntentRole[] {
  if (!Array.isArray(value)) return [...DEFAULT_ROLES];
  const roles = value.filter(
    (role): role is IntentRole => role === "drums" || role === "bass" || role === "chords" || role === "lead",
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

/**
 * Normalize untrusted user/provider data into one canonical IntentSpec.
 *
 * `doc` is the document the generation will land in. When it is known, the
 * length is measured in that document's meter: the default is ONE BAR of it
 * (not sixteen steps), a bar-framed request (`bars`) is turned into steps by
 * the meter, and a step-framed request is rounded to a whole number of its
 * bars. Without a document the meter is unknown and the 4/4 bar is assumed —
 * which keeps every document-independent call byte-identical to before.
 */
export function normalizeIntent(
  input: IntentInput | unknown = {},
  doc?: Pick<ProjectDocument, "timeSignature">,
): IntentSpec {
  const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  // The REQUESTED meter wins over the document's meter for the LENGTH: a bar
  // is twelve steps in 3/4 and 6/8, sixteen in 4/4. "Two bars in 3/4" is
  // twenty-four steps, not thirty-two (ADR 0057 Stage 2f).
  const requested = requestedMeter(source.timeSignature);
  const perBar = requested ? stepsPerBarFor(requested) : doc ? stepsPerBar(doc) : DEFAULT_STEPS_PER_BAR;
  const bars = barsOf(source.bars, perBar);
  // The step count alone expresses the request in 4/4 — a bar is sixteen
  // steps there — so the bar count is recorded ONLY where it says something
  // the steps cannot: in the meters where a bar is not sixteen steps. That
  // keeps every 4/4 intent byte-identical to before (same hash, same
  // generated beat) and only changes the meters that were wrong.
  const carriesBars = bars !== null && bars * perBar !== bars * DEFAULT_STEPS_PER_BAR;
  const controls =
    source.controls && typeof source.controls === "object" ? (source.controls as Record<string, unknown>) : {};
  const targetTracks =
    source.targetTracks && typeof source.targetTracks === "object"
      ? (source.targetTracks as Record<string, unknown>)
      : {};
  const constraints =
    source.constraints && typeof source.constraints === "object" ? (source.constraints as Record<string, unknown>) : {};
  // Protected roles — sanitized to the canonical role order (deterministic
  // hash regardless of phrase order); empty → field omitted entirely so
  // pre-Fáza-1 canonical hashes are unchanged.
  const preserve = Array.isArray(source.preserve)
    ? DEFAULT_ROLES.filter((role) => (source.preserve as unknown[]).includes(role))
    : [];
  const genre = GENRES.includes(source.genre as (typeof GENRES)[number])
    ? (source.genre as GenerateOptions["genre"])
    : DEFAULT_GENERATE_OPTIONS.genre;
  const normalized: IntentSpec = {
    version: INTENT_SCHEMA_VERSION,
    genre,
    style: text(source.style),
    ...(genre === "trap" &&
    PRODUCTION_PROFILES.includes(source.productionProfile as (typeof PRODUCTION_PROFILES)[number])
      ? { productionProfile: source.productionProfile as (typeof PRODUCTION_PROFILES)[number] }
      : {}),
    // Artist-preset label — key into the artist mix-signature table. Omitted
    // when absent so legacy canonical hashes are unchanged.
    ...(typeof source.artist === "string" && source.artist.trim().length > 0
      ? { artist: source.artist.trim().slice(0, 64) }
      : {}),
    ...(source.flow === "straight" || source.flow === "triplet" || source.flow === "offbeat"
      ? { flow: source.flow }
      : {}),
    // Song-level harmony plan name — omitted when absent so legacy canonical
    // hashes are unchanged. Resolution validates against the genre's own
    // table downstream (an unknown name falls back to the seeded pick).
    ...(typeof source.progression === "string" && source.progression.trim().length > 0
      ? { progression: source.progression.trim().slice(0, 128) }
      : {}),
    mood: text(source.mood),
    energy: unit(source.energy, 0.7),
    density: unit(source.density, 0.5),
    complexity: unit(source.complexity, 0.5),
    variation: unit(source.variation, DEFAULT_GENERATE_OPTIONS.velocityVariation),
    seed: typeof source.seed === "string" ? source.seed.slice(0, 128) : DEFAULT_GENERATE_OPTIONS.seed,
    ...(typeof source.text === "string" && source.text.trim().length > 0
      ? { text: source.text.trim().slice(0, 300) }
      : {}),
    key: isMusicalKey(source.key) ? source.key : null,
    bpmRange: bpmRangeOf(source.bpmRange),
    length: bars !== null ? bars * perBar : lengthOf(source.length, perBar),
    ...(carriesBars ? { bars: bars as number } : {}),
    // The requested meter rides with the intent so the plan can generate in
    // it. Omitted when absent, so a 4/4 intent's canonical hash is unchanged.
    ...(requested ? { timeSignature: requested } : {}),
    candidateCount: candidateCountOf(source.candidateCount),
    symbolicCandidates: symbolicCandidatesOf(source.symbolicCandidates),
    roles: rolesOf(source.roles),
    ...(preserve.length > 0 ? { preserve } : {}),
    targetTracks: {
      drumTrackId:
        typeof targetTracks.drumTrackId === "string" && targetTracks.drumTrackId.length > 0
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
    sourcePatternId:
      typeof source.sourcePatternId === "string" && source.sourcePatternId.length > 0 ? source.sourcePatternId : null,
    replaceMode: source.replaceMode === "replace" ? "replace" : "new",
    applyGrooveSettings: bool(source.applyGrooveSettings, false),
    // FX riding with the generation — sanitized (invalid data drops to null,
    // never rejects the intent).
    fx: sanitizeFxIntent(source.fx),
  };
  assertIntentSpec(normalized);
  return normalized;
}

export function intentFromGenerateOptions(options: GenerateOptions): IntentSpec {
  return normalizeIntent({
    genre: options.genre,
    style: options.style,
    productionProfile: options.productionProfile,
    seed: options.seed,
    key: options.key ?? null,
    bpmRange: options.bpmRange ?? null,
    length: options.stepCount,
    candidateCount: options.candidateCount,
    variation: options.velocityVariation,
    controls: {
      ghostWeight: options.ghostWeight,
      microWeight: options.microWeight,
      velocityVariation: options.velocityVariation,
      temperature: options.temperature,
    },
    ...(options.progression ? { progression: options.progression } : {}),
    targetTracks: {
      drumTrackId: options.drumTrackId ?? null,
      instrumentTrackIds: options.instrumentTrackIds ?? [],
    },
    roles: options.roles,
    constraints: options.constraints,
    sourcePatternId: options.sourcePatternId ?? null,
    replaceMode: options.replaceMode,
    applyGrooveSettings: options.applyGrooveSettings ?? false,
  });
}
