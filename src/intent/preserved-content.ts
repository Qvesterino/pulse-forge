import { drumTrackForTarget, instrumentTrackForRole } from "../ai/role-targets";
import { STEP_TICKS, type NoteEvent, type Pattern, type ProjectDocument } from "../project-model/types";
import { uid } from "../shared/ids";
import type { GenerationPlan, IntentRole } from "./types";

export interface PreserveViolation {
  id: string;
  detail: string;
}

export interface PreservedContentResult {
  pattern: Pattern;
  violations: readonly PreserveViolation[];
}

const MELODIC_TRACK_ROLE: Readonly<Partial<Record<IntentRole, "bass" | "chord" | "lead">>> = {
  bass: "bass",
  chords: "chord",
  lead: "lead",
};

function rowHasContentAfter(row: readonly number[], stepCount: number): boolean {
  return row.slice(stepCount).some((velocity) => Number.isFinite(velocity) && velocity > 0);
}

function resizePreservedRow(row: readonly number[], stepCount: number): number[] {
  return Array.from({ length: stepCount }, (_, index) => row[index] ?? 0);
}

function noteEndsAfter(note: NoteEvent, endTick: number): boolean {
  return note.start + note.duration > endTick;
}

/**
 * Restore explicitly protected source material into every candidate before
 * audition, ranking or apply. Drum roles are pad-scoped; melodic roles lock
 * the instrument track selected by the same deterministic mapping used by
 * the generators. Repeated calls are idempotent until `freshNoteIds` is set
 * for the final accepted candidate.
 */
export function preserveSourceContent(
  pattern: Pattern,
  plan: GenerationPlan,
  doc: ProjectDocument,
  options: { freshNoteIds?: boolean } = {},
): PreservedContentResult {
  const roles = plan.intent.preserve ?? [];
  if (roles.length === 0) return { pattern, violations: [] };

  const sourceId = plan.preserveSourcePatternId ?? plan.intent.sourcePatternId;
  const source = doc.patterns.find((candidate) => candidate.id === sourceId);
  const violations: PreserveViolation[] = [];
  if (!source) {
    return {
      pattern,
      violations: [{ id: "preserve-source-missing", detail: "no source pattern is available for protected content" }],
    };
  }

  const rows = { ...pattern.rows };
  const stepMeta = { ...(pattern.stepMeta ?? {}) };
  const notes = { ...pattern.notes };
  const targetStepCount = pattern.stepCount;
  const targetEndTick = targetStepCount * STEP_TICKS;

  if (roles.includes("drums")) {
    const drumTrack = drumTrackForTarget(doc, plan.options.drumTrackId);
    if (!drumTrack) {
      violations.push({ id: "preserve-track-missing", detail: "no drum track is available for protected content" });
    } else {
      for (const pad of drumTrack.pads) {
        delete rows[pad.id];
        delete stepMeta[pad.id];
        const sourceRow = source.rows[pad.id];
        if (sourceRow) {
          if (rowHasContentAfter(sourceRow, targetStepCount)) {
            violations.push({
              id: "preserve-length",
              detail: `protected drum row ${pad.name} has hits beyond the requested ${targetStepCount}-step length`,
            });
          }
          rows[pad.id] = resizePreservedRow(sourceRow, targetStepCount);
        }
        const sourceMeta = source.stepMeta?.[pad.id];
        if (sourceMeta) {
          const retainedMeta = Object.fromEntries(
            Object.entries(sourceMeta).filter(([step]) => Number(step) < targetStepCount),
          );
          if (Object.keys(retainedMeta).length > 0) stepMeta[pad.id] = retainedMeta;
        }
      }
    }
  }

  const protectedTrackIds = new Set<string>();
  for (const role of roles) {
    const melodicRole = MELODIC_TRACK_ROLE[role];
    if (!melodicRole) continue;
    const track = instrumentTrackForRole(doc, melodicRole, plan.options.instrumentTrackIds);
    if (!track) {
      violations.push({
        id: "preserve-track-missing",
        detail: `no instrument track is available for protected ${role}`,
      });
      continue;
    }
    protectedTrackIds.add(track.id);
  }

  for (const trackId of protectedTrackIds) {
    const sourceNotes = source.notes[trackId] ?? [];
    if (sourceNotes.some((note) => noteEndsAfter(note, targetEndTick))) {
      violations.push({
        id: "preserve-length",
        detail: `protected instrument notes on ${trackId} extend beyond the requested ${targetStepCount}-step length`,
      });
      continue;
    }

    const sourceIds = new Set(sourceNotes.map((note) => note.id));
    const generatedNotes = (notes[trackId] ?? []).filter((note) => !sourceIds.has(note.id));
    const restoredNotes = sourceNotes.map((note) => ({ ...note, id: options.freshNoteIds ? uid("note") : note.id }));
    const mergedNotes = [...generatedNotes, ...restoredNotes];
    if (mergedNotes.length > 0) {
      notes[trackId] = mergedNotes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    } else {
      delete notes[trackId];
    }
  }

  if (violations.length > 0) return { pattern, violations };
  return {
    pattern: {
      ...pattern,
      rows,
      notes,
      ...(Object.keys(stepMeta).length > 0 ? { stepMeta } : { stepMeta: undefined }),
    },
    violations,
  };
}
