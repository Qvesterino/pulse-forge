import { buildPhrasePlan } from "../ai/phrase";
import { canonicalizePattern, contentHash, createGenerationRecipe } from "../ai/evaluation";
import { resolveGrooveForGeneration } from "../ai/generator";
import type { GenerateOptions } from "../ai/types";
import { inferPadRole } from "../ai/pad-roles";
import { measureDrumQuality, measureMelodicQuality } from "../ai/quality";
import { evaluateStyleDistance } from "../ai/style-quality";
import { parseKey, snapToScale } from "../project-model/scales";
import {
  STEP_TICKS,
  type MusicalKey,
  type NoteEvent,
  type Pattern,
  type ProjectDocument,
  type StepMeta,
} from "../project-model/types";
import { uid } from "../shared/ids";

export interface PatternRepairResult {
  pattern: Pattern;
  repairs: string[];
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clamp(value, min, max, fallback));
}

function repairKey(key: MusicalKey | null | undefined): MusicalKey | null {
  return key && parseKey(key) ? key : null;
}

function hasValidPhrasePlan(value: unknown, stepCount: number): boolean {
  if (!Array.isArray(value)) return false;
  const sections = new Set(["main", "variation", "drop", "fill", "outro"]);
  let previousEnd = -1;
  for (const bar of value) {
    if (!bar || typeof bar !== "object") return false;
    const item = bar as Record<string, unknown>;
    if (
      !Number.isInteger(item.bar) ||
      !Number.isInteger(item.startStep) ||
      !Number.isInteger(item.endStep) ||
      (item.startStep as number) < 0 ||
      (item.endStep as number) <= (item.startStep as number) ||
      (item.endStep as number) > stepCount ||
      !sections.has(String(item.section)) ||
      (item.startStep as number) < previousEnd
    ) {
      return false;
    }
    previousEnd = item.endStep as number;
  }
  return true;
}

/**
 * Deterministically repair the small set of shape/range problems that can
 * cross the provider boundary. The function is deliberately conservative:
 * unknown entities are dropped, while known entities are clamped in place.
 */
export function repairGeneratedPattern(
  doc: ProjectDocument,
  candidate: Pattern,
  stepCount: number,
  key?: MusicalKey | null,
): PatternRepairResult {
  const repairs = new Set<string>();
  const source = candidate as Partial<Pattern>;
  const patternTicks = stepCount * STEP_TICKS;
  const padIds = new Set(
    doc.tracks.filter((track) => track.kind === "drum").flatMap((track) => track.pads.map((pad) => pad.id)),
  );
  const instrumentIds = new Set(doc.tracks.filter((track) => track.kind === "instrument").map((track) => track.id));
  const scaleKey = repairKey(key ?? doc.key);

  const rows: Record<string, number[]> = {};
  const sourceRows = source.rows && typeof source.rows === "object" ? source.rows : {};
  for (const [padId, values] of Object.entries(sourceRows)) {
    if (!padIds.has(padId)) {
      repairs.add("unknown-pad-row");
      continue;
    }
    const next = new Array(stepCount).fill(0);
    if (!Array.isArray(values)) {
      repairs.add("row-shape");
    } else {
      if (values.length !== stepCount) repairs.add("row-shape");
      for (let step = 0; step < stepCount; step++) {
        const value = clamp(values[step], 0, 1, 0);
        if (value !== values[step]) repairs.add("row-value");
        next[step] = value;
      }
    }
    rows[padId] = next;
  }

  const notes: Record<string, NoteEvent[]> = {};
  const sourceNotes = source.notes && typeof source.notes === "object" ? source.notes : {};
  for (const [trackId, trackNotes] of Object.entries(sourceNotes)) {
    if (!instrumentIds.has(trackId)) {
      repairs.add("unknown-note-track");
      continue;
    }
    if (!Array.isArray(trackNotes)) {
      repairs.add("note-shape");
      continue;
    }
    notes[trackId] = [];
    for (const rawNote of trackNotes) {
      if (!rawNote || typeof rawNote !== "object") {
        repairs.add("note-shape");
        continue;
      }
      const note = rawNote as Partial<NoteEvent>;
      const start = integer(note.start, 0, Math.max(0, patternTicks - 1), 0);
      const duration = integer(note.duration, 1, Math.max(1, patternTicks - start), 1);
      let pitch = integer(note.pitch, 0, 127, 60);
      if (pitch !== note.pitch) repairs.add("note-pitch");
      if (scaleKey) {
        const snapped = snapToScale(pitch, scaleKey);
        if (snapped !== pitch) repairs.add("note-scale");
        pitch = snapped;
      }
      const velocity = clamp(note.velocity, 0, 1, 0.7);
      if (start !== note.start) repairs.add("note-start");
      if (duration !== note.duration) repairs.add("note-duration");
      if (velocity !== note.velocity) repairs.add("note-velocity");
      notes[trackId].push({
        id: typeof note.id === "string" && note.id.length > 0 ? note.id : uid("note"),
        pitch,
        start,
        duration,
        velocity,
        ...(note.slide !== undefined ? { slide: Boolean(note.slide) } : {}),
        ...(note.locks ? { locks: { ...note.locks } } : {}),
      });
    }
  }

  const stepMeta: Record<string, Record<number, StepMeta>> = {};
  const sourceMeta = source.stepMeta && typeof source.stepMeta === "object" ? source.stepMeta : {};
  for (const [padId, steps] of Object.entries(sourceMeta)) {
    if (!padIds.has(padId) || !steps || typeof steps !== "object") {
      repairs.add("metadata-shape");
      continue;
    }
    for (const [stepKey, rawMeta] of Object.entries(steps)) {
      const step = Number(stepKey);
      if (!Number.isInteger(step) || step < 0 || step >= stepCount || (rows[padId]?.[step] ?? 0) <= 0) {
        repairs.add("metadata-shape");
        continue;
      }
      if (!rawMeta || typeof rawMeta !== "object") {
        repairs.add("metadata-shape");
        continue;
      }
      const meta = rawMeta as StepMeta;
      const normalized: StepMeta = {
        ...(meta.probability !== undefined ? { probability: clamp(meta.probability, 0, 1, 1) } : {}),
        ...(meta.ratchet !== undefined ? { ratchet: integer(meta.ratchet, 1, 8, 1) } : {}),
        ...(meta.microtiming !== undefined ? { microtiming: clamp(meta.microtiming, -1, 1, 0) } : {}),
        ...(meta.amount !== undefined ? { amount: clamp(meta.amount, 0, 1, 1) } : {}),
        ...(meta.locks ? { locks: { ...meta.locks } } : {}),
      };
      if (
        normalized.probability !== meta.probability ||
        normalized.ratchet !== meta.ratchet ||
        normalized.microtiming !== meta.microtiming ||
        normalized.amount !== meta.amount
      ) {
        repairs.add("metadata-value");
      }
      (stepMeta[padId] ??= {})[step] = normalized;
    }
  }

  const phrasePlan = hasValidPhrasePlan(source.phrasePlan, stepCount) ? source.phrasePlan! : buildPhrasePlan(stepCount);
  if (!hasValidPhrasePlan(source.phrasePlan, stepCount)) repairs.add("phrase-plan");

  return {
    pattern: {
      id: typeof source.id === "string" ? source.id : uid("pattern"),
      name: typeof source.name === "string" ? source.name : "Repaired pattern",
      stepCount,
      rows,
      notes,
      ...(Object.keys(stepMeta).length > 0 ? { stepMeta } : {}),
      phrasePlan,
      ...(source.assist ? { assist: source.assist } : {}),
      ...(source.generation ? { generation: source.generation } : {}),
    },
    repairs: [...repairs],
  };
}

export function refreshPatternOutputHash(doc: ProjectDocument, pattern: Pattern): Pattern {
  if (!pattern.generation) return pattern;
  return {
    ...pattern,
    generation: {
      ...pattern.generation,
      outputContentHash: contentHash(canonicalizePattern(doc, pattern)),
    },
  };
}

/** Recompute diagnostics after repair so quality metrics describe final content. */
export function refreshPatternQuality(doc: ProjectDocument, pattern: Pattern, options: GenerateOptions): Pattern {
  if (!pattern.generation) return pattern;
  const groove = resolveGrooveForGeneration(doc, options);
  const drumTracks = doc.tracks.filter((track) => track.kind === "drum");
  const targetDrumTrack = options.drumTrackId
    ? (drumTracks.find((track) => track.id === options.drumTrackId) ?? drumTracks[0])
    : drumTracks[0];
  const drumRows = targetDrumTrack?.kind === "drum" ? targetDrumTrack.pads.map((pad) => pattern.rows[pad.id]) : [];
  const padRoles =
    targetDrumTrack?.kind === "drum" ? targetDrumTrack.pads.map((pad, index) => inferPadRole(pad.name, index)) : [];
  const drumQuality = measureDrumQuality(groove, drumRows, padRoles, options.stepCount);
  const styleGate = evaluateStyleDistance(groove, drumRows, options.stepCount);
  const melodicQuality = measureMelodicQuality(
    Object.values(pattern.notes ?? {}).flat(),
    options.stepCount,
    options.key ?? doc.key,
  );
  return {
    ...pattern,
    generation: {
      ...pattern.generation,
      quality: {
        styleDistance: styleGate.distance,
        styleAccepted: styleGate.accepted,
        syncopation: drumQuality.syncopation,
        anchorCoverage: drumQuality.anchorCoverage,
        melodicMotifRepetition: melodicQuality.motifRepetition,
        melodicRestRatio: melodicQuality.restRatio,
        melodicDurationLongRatio: melodicQuality.durationDistribution.long,
      },
    },
  };
}

/** Minimal, always-valid offline output used when the primary generator fails. */
export function createFallbackPattern(doc: ProjectDocument, options: GenerateOptions): Pattern {
  const groove = resolveGrooveForGeneration(doc, options);
  const drumTracks = doc.tracks.filter((track) => track.kind === "drum");
  const targetDrumTrack = options.drumTrackId
    ? (drumTracks.find((track) => track.id === options.drumTrackId) ?? drumTracks[0])
    : drumTracks[0];
  const rows: Record<string, number[]> = {};
  if (!options.roles || options.roles.includes("drums")) {
    for (const [padIndex, pad] of targetDrumTrack?.pads.entries() ?? []) {
      if (!groove.activePads.includes(padIndex)) continue;
      const base = groove.patterns[0]?.[padIndex] ?? [];
      rows[pad.id] = Array.from({ length: options.stepCount }, (_, step) =>
        clamp(base[step % Math.max(1, base.length)], 0, 1, 0),
      );
    }
  }
  const pattern: Pattern = {
    id: uid("pattern"),
    name: `${groove.genre} - ${groove.name} (fallback)`,
    stepCount: options.stepCount,
    rows,
    notes: {},
    phrasePlan: buildPhrasePlan(options.stepCount),
    generation: {
      ...createGenerationRecipe(options, groove.id, null),
      outputContentHash: "",
    },
  };
  return refreshPatternOutputHash(doc, pattern);
}
