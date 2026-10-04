import type { GenerateOptions } from "../types";
import type { NoteEvent, Pattern, ProjectDocument } from "../../project-model/types";
import { extractPatternFeatures, FEATURE_COUNT, FEATURE_NAMES, type PatternFeatureInput } from "./pattern-features";
import { instrumentTrackForRole } from "../role-targets";

/**
 * features.v2 — the Producer DNA feature contract (W4).
 *
 * ADDITIVE, not a replacement: the first `FEATURE_COUNT` values are the
 * EXACT features.v1 vector (same order, same normalization, byte-identical),
 * followed by 15 new bass / harmony / arrangement measurements. That prefix
 * invariant is what makes the migration safe:
 *
 *   - the shipped 54-dim intent ranker keeps consuming the v1 prefix through
 *     `extractPatternFeatures` and never sees this module;
 *   - old Producer DNA observations (featureVersion "features.v1") remain
 *     valid — `normalizeFeatureVector` pads them to v2 width with neutral 0.5,
 *     so their A/B differences are exactly zero on the new axes and they
 *     cannot train or perturb bass/harmony weights;
 *   - new observations carry the full v2 width and can.
 *
 * WHAT IS MEASURED (all deterministic, pure, [0,1]-clipped):
 *
 *   bass (5)        note density, root alignment against the chord lane,
 *                   melodic movement, syncopation, register stability
 *   harmony (4)     voicing movement (voice-leading quality), harmonic
 *                   rhythm, voicing richness, chord density
 *   arrangement (3) role count, register spread, bass/chord rhythmic lock
 *   flags (3)       per-role presence (1 = absent, matching the v1 flag
 *                   convention so a true zero is never read as a measurement)
 *
 * Role resolution reuses the GENERATOR's own resolver
 * (`instrumentTrackForRole`) so the feature extractor and the engine can
 * never disagree about which track is "the bass".
 */

export const FEATURE_CONTRACT_V2 = {
  version: "features.v2",
  /** Same fixed normalization constants as v1 — never batch-normalized. */
  normalizationId: "norm.fixed.v1",
  /** Width of the inherited v1 prefix. */
  prefixCount: FEATURE_COUNT,
} as const;

/** The 15 new feature names, in fixed order, appended after the v1 prefix. */
export const FEATURE_V2_EXTENSION_NAMES: readonly string[] = [
  // bass (5)
  "bass.noteDensity",
  "bass.rootAlignment",
  "bass.movement",
  "bass.syncopation",
  "bass.registerStability",
  // harmony (4)
  "harmony.voicingMovement",
  "harmony.harmonicRhythm",
  "harmony.voiceRichness",
  "harmony.chordDensity",
  // arrangement (3)
  "arrangement.roleCount",
  "arrangement.registerSpread",
  "arrangement.rhythmicAlignment",
  // role presence flags (3) — 1 = absent (v1 flag convention)
  "flags.bassAbsent",
  "flags.chordsAbsent",
  "flags.leadAbsent",
] as const;

/** Full v2 feature order: v1 prefix followed by the extension. */
export const FEATURE_V2_NAMES: readonly string[] = [...FEATURE_NAMES, ...FEATURE_V2_EXTENSION_NAMES];

export const FEATURE_V2_COUNT = FEATURE_V2_NAMES.length;

export interface PatternFeatureVectorV2 {
  version: "features.v2";
  values: Float32Array;
  names: readonly string[];
  finite: boolean;
  /** New-axis values clipped to range (diagnostics). */
  clippedCount: number;
  featureHash: string;
}

/* ────────────────────────── small pure helpers ────────────────────────── */

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Normalize any accepted feature vector to v2 width.
 *
 * - v1 width: padded with 0.5 (neutral) — differences on the new axes are
 *   exactly zero, so a v1 observation can never influence a v2-only weight.
 * - v2 width: returned as a plain array.
 * - anything else: null (the caller treats it as unusable).
 */
export function normalizeFeatureVector(features: ArrayLike<number>): number[] | null {
  if (features.length === FEATURE_V2_COUNT) {
    const out = new Array<number>(FEATURE_V2_COUNT);
    for (let i = 0; i < FEATURE_V2_COUNT; i++) {
      const value = features[i];
      if (!Number.isFinite(value) || value < 0 || value > 1) return null;
      out[i] = value;
    }
    return out;
  }
  if (features.length === FEATURE_COUNT) {
    const out = new Array<number>(FEATURE_V2_COUNT).fill(0.5);
    for (let i = 0; i < FEATURE_COUNT; i++) {
      const value = features[i];
      if (!Number.isFinite(value) || value < 0 || value > 1) return null;
      out[i] = value;
    }
    return out;
  }
  return null;
}

/** True when a vector is usable at either contract width. */
export function isSupportedFeatureVector(features: ArrayLike<number>): boolean {
  return features.length === FEATURE_COUNT || features.length === FEATURE_V2_COUNT;
}

/* ────────────────────────── lane statistics ────────────────────────── */

interface LaneStats {
  present: boolean;
  notes: NoteEvent[];
  hits: number;
}

function laneStats(pattern: Pattern, doc: ProjectDocument, role: "bass" | "chord" | "lead", options: GenerateOptions): LaneStats {
  const track = instrumentTrackForRole(doc, role, options.instrumentTrackIds);
  if (!track) return { present: false, notes: [], hits: 0 };
  const notes = [...(pattern.notes?.[track.id] ?? [])].sort(
    (a, b) => a.start - b.start || a.pitch - b.pitch,
  );
  return { present: notes.length > 0, notes, hits: notes.length };
}

/** Group notes sharing a start tick into "events" (chord voicings / bass attacks). */
function groupByStart(notes: readonly NoteEvent[]): { start: number; pitches: number[]; duration: number }[] {
  const groups: { start: number; pitches: number[]; duration: number }[] = [];
  for (const note of notes) {
    const last = groups[groups.length - 1];
    if (last && last.start === note.start) {
      last.pitches.push(note.pitch);
      last.duration = Math.max(last.duration, note.duration);
    } else {
      groups.push({ start: note.start, pitches: [note.pitch], duration: note.duration });
    }
  }
  for (const group of groups) group.pitches.sort((a, b) => a - b);
  return groups;
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}

/* ────────────────────────── the extractor ────────────────────────── */

export function extractPatternFeaturesV2(input: PatternFeatureInput): PatternFeatureVectorV2 {
  const v1 = extractPatternFeatures(input);
  const { doc, pattern, options } = input;
  const stepCount = Math.max(1, options.stepCount);

  const bass = laneStats(pattern, doc, "bass", options);
  const chords = laneStats(pattern, doc, "chord", options);
  const lead = laneStats(pattern, doc, "lead", options);

  const values: number[] = [];
  let clippedCount = 0;
  const push = (value: number | undefined, fallback = 0): void => {
    const base = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const clamped = clamp01(base);
    if (clamped !== base) clippedCount += 1;
    values.push(Math.round(clamped * 10_000) / 10_000);
  };

  // ── bass (5) ─────────────────────────────────────────────────────────────
  const bassEvents = groupByStart(bass.notes);
  push(bass.hits / stepCount); // noteDensity
  // Root alignment: share of bass attacks whose pitch class matches the
  // LOWEST sounding chord pitch class at that instant. No chord context →
  // neutral 0.5 (a missing reference is not evidence of misalignment).
  {
    const chordEvents = groupByStart(chords.notes);
    let matched = 0;
    let aligned = 0;
    for (const event of bassEvents) {
      // The chord sounding at this attack is the last one starting at or before it.
      let context: { pitches: number[]; duration: number } | null = null;
      for (const chord of chordEvents) {
        if (chord.start <= event.start && event.start < chord.start + Math.max(1, chord.duration)) context = chord;
        if (chord.start > event.start) break;
      }
      if (!context) continue;
      matched += 1;
      if (pitchClass(event.pitches[0] ?? 0) === pitchClass(context.pitches[0] ?? 0)) aligned += 1;
    }
    push(matched > 0 ? aligned / matched : 0.5);
  }
  // Movement: mean absolute interval between consecutive bass attacks / 12.
  {
    const intervals: number[] = [];
    for (let i = 1; i < bassEvents.length; i++) {
      intervals.push(Math.abs((bassEvents[i].pitches[0] ?? 0) - (bassEvents[i - 1].pitches[0] ?? 0)));
    }
    push(intervals.length > 0 ? mean(intervals) / 12 : 0.5);
  }
  // Syncopation: share of bass attacks that are NOT on a 16th downbeat (step % 4 === 0).
  {
    const offbeat = bass.notes.filter((note) => Math.round(note.start / 120) % 4 !== 0).length;
    push(bass.hits > 0 ? offbeat / bass.hits : 0);
  }
  // Register stability: 1 − normalized pitch spread (std / 12, clamped).
  {
    const pitches = bass.notes.map((note) => note.pitch);
    if (pitches.length >= 2) {
      const average = mean(pitches);
      const variance = mean(pitches.map((pitch) => (pitch - average) ** 2));
      push(1 - clamp01(Math.sqrt(variance) / 12));
    } else {
      push(0.5);
    }
  }

  // ── harmony (4) ──────────────────────────────────────────────────────────
  const chordEvents = groupByStart(chords.notes);
  // Voicing movement: mean semitone distance between consecutive voicings'
  // aligned voices (voice-leading quality; low = smooth).
  {
    const movements: number[] = [];
    for (let i = 1; i < chordEvents.length; i++) {
      const previous = chordEvents[i - 1].pitches;
      const current = chordEvents[i].pitches;
      const voices = Math.min(previous.length, current.length);
      if (voices === 0) continue;
      let distance = 0;
      for (let voice = 0; voice < voices; voice++) distance += Math.abs(current[voice] - previous[voice]);
      movements.push(distance / voices);
    }
    push(movements.length > 0 ? mean(movements) / 12 : 0.5);
  }
  // Harmonic rhythm: mean chord-slot length in bars (16 steps), clamped.
  {
    const durations = chordEvents.map((event) => Math.max(1, Math.round(event.duration / 120)));
    push(durations.length > 0 ? mean(durations) / 16 : 0.5);
  }
  // Voicing richness: mean simultaneous notes per chord event / 6.
  push(chordEvents.length > 0 ? clamp01(mean(chordEvents.map((event) => event.pitches.length)) / 6) : 0);
  // Chord density: chord notes per step, clamped (a 4-note voicing every step
  // would be 4.0; the /4 constant keeps typical densities inside [0,1]).
  push(chords.hits / Math.max(1, stepCount) / 4);

  // ── arrangement (3) ──────────────────────────────────────────────────────
  const presentRoles = [bass, chords, lead].filter((lane) => lane.present).length;
  push(presentRoles / 3); // roleCount
  // Register spread: distance between lead and bass mean pitch / 48 (four octaves).
  {
    if (bass.present && lead.present) {
      const bassMean = mean(bass.notes.map((note) => note.pitch));
      const leadMean = mean(lead.notes.map((note) => note.pitch));
      push(Math.abs(leadMean - bassMean) / 48);
    } else {
      push(0.5);
    }
  }
  // Rhythmic alignment: share of bass attacks that land on a step where a
  // chord attack also lands (the "locked" band feel).
  {
    if (bassEvents.length === 0 || chordEvents.length === 0) {
      push(0.5);
    } else {
      const chordStarts = new Set(chordEvents.map((event) => event.start));
      const locked = bassEvents.filter((event) => chordStarts.has(event.start)).length;
      push(locked / bassEvents.length);
    }
  }

  // ── role presence flags (3) — 1 = absent (v1 convention) ─────────────────
  push(bass.present ? 0 : 1);
  push(chords.present ? 0 : 1);
  push(lead.present ? 0 : 1);

  if (values.length !== FEATURE_V2_EXTENSION_NAMES.length) {
    throw new Error(`features.v2 extension width drift: ${values.length} != ${FEATURE_V2_EXTENSION_NAMES.length}`);
  }

  // Full v2 vector: the byte-identical v1 prefix + the extension.
  const full = new Float32Array(FEATURE_V2_COUNT);
  full.set(v1.values, 0);
  full.set(values, FEATURE_COUNT);

  return {
    version: FEATURE_CONTRACT_V2.version,
    values: full,
    names: FEATURE_V2_NAMES,
    finite: v1.finite && values.every((value) => Number.isFinite(value)),
    clippedCount: v1.clippedCount + clippedCount,
    featureHash: hashValues(full),
  };
}

/** FNV-1a over the rounded full vector — mirrors the v1 hash helper. */
function hashValues(values: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < values.length; index++) {
    const rounded = Math.round(values[index] * 10_000);
    const bytes = [rounded & 0xff, (rounded >> 8) & 0xff, (rounded >> 16) & 0xff, (rounded >> 24) & 0xff];
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

/** Feature indices for the bass extension axes (v2 positions). */
export const BASS_FEATURE_INDICES: readonly number[] = FEATURE_V2_EXTENSION_NAMES.flatMap((name, index) =>
  name.startsWith("bass.") ? [FEATURE_COUNT + index] : [],
);

/** Feature indices for the harmony extension axes (v2 positions). */
export const HARMONY_FEATURE_INDICES: readonly number[] = FEATURE_V2_EXTENSION_NAMES.flatMap((name, index) =>
  name.startsWith("harmony.") ? [FEATURE_COUNT + index] : [],
);

/** Feature indices for the arrangement extension axes (v2 positions). */
export const ARRANGEMENT_FEATURE_INDICES: readonly number[] = FEATURE_V2_EXTENSION_NAMES.flatMap((name, index) =>
  name.startsWith("arrangement.") ? [FEATURE_COUNT + index] : [],
);
