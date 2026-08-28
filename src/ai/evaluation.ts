import type { NoteEvent, Pattern, PatternGeneration, ProjectDocument, StepMeta } from "../project-model/types";
import type { GenerateOptions } from "./types";
import { hashString } from "../shared/rng";

/** Stable identity for the pre-IntentSpec local generator baseline. */
export const LOCAL_ENGINE_ID = "pulse-forge.local-groove";
export const LOCAL_ENGINE_VERSION = "correctness-1";

export interface CanonicalRow {
  trackIndex: number;
  padIndex: number;
  values: number[];
}

export interface CanonicalNote {
  trackIndex: number;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface CanonicalStepMeta {
  trackIndex: number;
  padIndex: number;
  steps: Array<{ step: number; meta: StepMeta }>;
}

/**
 * Pattern content with runtime identity removed.
 *
 * Project UUIDs are intentionally excluded: they identify project entities,
 * but they are not part of the generated musical result.
 */
export interface CanonicalPatternContent {
  stepCount: number;
  rows: CanonicalRow[];
  notes: CanonicalNote[];
  stepMeta: CanonicalStepMeta[];
}

export interface PatternMetrics {
  drumRows: number;
  drumHits: number;
  drumDensity: number;
  downbeatHits: number;
  downbeatRatio: number;
  stepMetaEntries: number;
  melodicNotes: number;
  melodicDensity: number;
  pitchMin: number | null;
  pitchMax: number | null;
  pitchMean: number | null;
  maxNoteEnd: number | null;
}

export type GenerationRecipeSummary = PatternGeneration;

function stableNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Deterministic JSON with sorted object keys and normalized numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(stableNumber(value));
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${entries.join(",")}}`;
  }

  return "null";
}

function compareLocations(
  a: { trackIndex: number; padIndex: number },
  b: { trackIndex: number; padIndex: number },
): number {
  return a.trackIndex - b.trackIndex || a.padIndex - b.padIndex;
}

function locationMaps(doc: ProjectDocument): {
  pads: Map<string, { trackIndex: number; padIndex: number }>;
  instruments: Map<string, number>;
} {
  const pads = new Map<string, { trackIndex: number; padIndex: number }>();
  let drumTrackIndex = 0;
  const instruments = new Map<string, number>();
  let instrumentTrackIndex = 0;

  for (const track of doc.tracks) {
    if (track.kind === "drum") {
      track.pads.forEach((pad, padIndex) => {
        pads.set(pad.id, { trackIndex: drumTrackIndex, padIndex });
      });
      drumTrackIndex++;
    }
    if (track.kind === "instrument") {
      instruments.set(track.id, instrumentTrackIndex);
      instrumentTrackIndex++;
    }
  }

  return { pads, instruments };
}

function canonicalMeta(meta: StepMeta): StepMeta {
  const result: StepMeta = {};
  if (meta.probability !== undefined) result.probability = stableNumber(meta.probability);
  if (meta.ratchet !== undefined) result.ratchet = stableNumber(meta.ratchet);
  if (meta.microtiming !== undefined) result.microtiming = stableNumber(meta.microtiming);
  return result;
}

/** Convert a Pattern into a UUID-free, order-stable content representation. */
export function canonicalizePattern(doc: ProjectDocument, pattern: Pattern): CanonicalPatternContent {
  const locations = locationMaps(doc);

  const rows = Object.entries(pattern.rows)
    .map(([padId, values]) => {
      const location = locations.pads.get(padId) ?? { trackIndex: -1, padIndex: -1 };
      return {
        ...location,
        values: values.map(stableNumber),
      };
    })
    .sort(compareLocations);

  const notes: CanonicalNote[] = [];
  for (const [trackId, trackNotes] of Object.entries(pattern.notes ?? {})) {
    const trackIndex = locations.instruments.get(trackId) ?? -1;
    for (const note of trackNotes) {
      notes.push({
        trackIndex,
        pitch: stableNumber(note.pitch),
        start: stableNumber(note.start),
        duration: stableNumber(note.duration),
        velocity: stableNumber(note.velocity),
      });
    }
  }
  notes.sort(
    (a, b) =>
      a.trackIndex - b.trackIndex ||
      a.start - b.start ||
      a.pitch - b.pitch ||
      a.duration - b.duration ||
      a.velocity - b.velocity,
  );

  const stepMeta: CanonicalStepMeta[] = [];
  for (const [padId, steps] of Object.entries(pattern.stepMeta ?? {})) {
    const location = locations.pads.get(padId) ?? { trackIndex: -1, padIndex: -1 };
    stepMeta.push({
      ...location,
      steps: Object.entries(steps)
        .map(([step, meta]) => ({ step: Number(step), meta: canonicalMeta(meta) }))
        .sort((a, b) => a.step - b.step),
    });
  }
  stepMeta.sort(compareLocations);

  return {
    stepCount: pattern.stepCount,
    rows,
    notes,
    stepMeta,
  };
}

export function contentHash(content: CanonicalPatternContent): string {
  return hashString(canonicalJson(content)).toString(16).padStart(8, "0");
}

export function createGenerationRecipe(
  options: GenerateOptions,
  grooveId: string,
  inputContentHash: string | null = null,
): GenerationRecipeSummary {
  return {
    engineId: LOCAL_ENGINE_ID,
    engineVersion: LOCAL_ENGINE_VERSION,
    seed: options.seed,
    genre: options.genre,
    style: options.style ?? null,
    grooveId,
    stepCount: options.stepCount,
    ghostWeight: stableNumber(options.ghostWeight),
    microWeight: stableNumber(options.microWeight),
    velocityVariation: stableNumber(options.velocityVariation),
    temperature: stableNumber(options.temperature),
    sourcePatternId: options.sourcePatternId ?? null,
    inputContentHash,
  };
}

function allNotes(pattern: Pattern): NoteEvent[] {
  return Object.values(pattern.notes ?? {}).flat();
}

export function measurePattern(pattern: Pattern): PatternMetrics {
  const rows = Object.values(pattern.rows);
  let drumHits = 0;
  let downbeatHits = 0;

  for (const row of rows) {
    for (let step = 0; step < row.length; step++) {
      if (row[step] > 0) {
        drumHits++;
        if (step % 4 === 0) downbeatHits++;
      }
    }
  }

  const notes = allNotes(pattern);
  const pitches = notes.map((note) => note.pitch);
  const maxNoteEnd = notes.length > 0 ? Math.max(...notes.map((note) => note.start + note.duration)) : null;

  return {
    drumRows: rows.length,
    drumHits,
    drumDensity: stableNumber(
      rows.length > 0 && pattern.stepCount > 0 ? drumHits / (rows.length * pattern.stepCount) : 0,
    ),
    downbeatHits,
    downbeatRatio: stableNumber(drumHits > 0 ? downbeatHits / drumHits : 0),
    stepMetaEntries: Object.values(pattern.stepMeta ?? {}).reduce(
      (total, steps) => total + Object.keys(steps).length,
      0,
    ),
    melodicNotes: notes.length,
    melodicDensity: stableNumber(pattern.stepCount > 0 ? notes.length / pattern.stepCount : 0),
    pitchMin: pitches.length > 0 ? Math.min(...pitches) : null,
    pitchMax: pitches.length > 0 ? Math.max(...pitches) : null,
    pitchMean:
      pitches.length > 0 ? stableNumber(pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length) : null,
    maxNoteEnd,
  };
}
