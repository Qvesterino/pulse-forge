import { canonicalizePattern, contentHash } from "./evaluation";
import { isInScale } from "../project-model/scales";
import { STEP_TICKS, type Pattern, type ProjectDocument } from "../project-model/types";

export type PatternInvariantCode =
  | "row-length"
  | "row-value"
  | "unknown-pad"
  | "note-track"
  | "note-pitch"
  | "note-start"
  | "note-duration"
  | "note-velocity"
  | "note-scale"
  | "metadata-pad"
  | "metadata-step"
  | "metadata-inactive-hit"
  | "metadata-value"
  | "phrase-plan"
  | "content-hash";

export interface PatternInvariantIssue {
  code: PatternInvariantCode;
  path: string;
  message: string;
}

export interface PatternInvariantReport {
  ok: boolean;
  issues: PatternInvariantIssue[];
}

const PHRASE_SECTIONS = new Set(["main", "variation", "drop", "fill", "outro"]);

function issue(issues: PatternInvariantIssue[], code: PatternInvariantCode, path: string, message: string): void {
  issues.push({ code, path, message });
}

/**
 * Strict, non-mutating quality gate for generated or Assist-produced content.
 *
 * `normalizeProject()` is intentionally a repair function. This module is the
 * opposite boundary: it reports anything that should have been repaired before
 * content is accepted, saved as a generated result, or used by an exporter.
 */
export function inspectPatternInvariants(
  doc: ProjectDocument,
  pattern: Pattern,
  options: { checkScale?: boolean } = {},
): PatternInvariantReport {
  const issues: PatternInvariantIssue[] = [];
  const stepCount = pattern.stepCount;
  const patternTicks = stepCount * STEP_TICKS;
  const padIds = new Set(
    doc.tracks.filter((track) => track.kind === "drum").flatMap((track) => track.pads.map((pad) => pad.id)),
  );
  const instrumentIds = new Set(doc.tracks.filter((track) => track.kind === "instrument").map((track) => track.id));

  for (const [padId, row] of Object.entries(pattern.rows ?? {})) {
    if (!padIds.has(padId))
      issue(issues, "unknown-pad", `rows.${padId}`, "row references a pad that is not in the project");
    if (!Array.isArray(row) || row.length !== stepCount) {
      issue(
        issues,
        "row-length",
        `rows.${padId}`,
        `expected ${stepCount} steps, got ${Array.isArray(row) ? row.length : "non-array"}`,
      );
      continue;
    }
    row.forEach((value, step) => {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        issue(issues, "row-value", `rows.${padId}.${step}`, "velocity must be finite and within 0..1");
      }
    });
  }

  for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
    if (!instrumentIds.has(trackId))
      issue(issues, "note-track", `notes.${trackId}`, "notes reference a non-instrument track");
    for (const [index, note] of notes.entries()) {
      const path = `notes.${trackId}.${index}`;
      if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
        issue(issues, "note-pitch", `${path}.pitch`, "pitch must be an integer in MIDI range 0..127");
      }
      if (!Number.isFinite(note.start) || note.start < 0 || note.start >= patternTicks) {
        issue(issues, "note-start", `${path}.start`, `start must be within 0..${Math.max(0, patternTicks - 1)}`);
      }
      if (!Number.isFinite(note.duration) || note.duration <= 0 || note.start + note.duration > patternTicks) {
        issue(issues, "note-duration", `${path}.duration`, "duration must be positive and fit inside the pattern");
      }
      if (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) {
        issue(issues, "note-velocity", `${path}.velocity`, "velocity must be finite and within 0..1");
      }
      if (options.checkScale && doc.key && Number.isInteger(note.pitch) && !isInScale(note.pitch, doc.key)) {
        issue(issues, "note-scale", `${path}.pitch`, `${note.pitch} is outside ${doc.key}`);
      }
    }
  }

  for (const [padId, steps] of Object.entries(pattern.stepMeta ?? {})) {
    if (!padIds.has(padId)) {
      issue(issues, "metadata-pad", `stepMeta.${padId}`, "metadata references a pad that is not in the project");
      continue;
    }
    for (const [stepKey, meta] of Object.entries(steps)) {
      const step = Number(stepKey);
      const path = `stepMeta.${padId}.${stepKey}`;
      if (!Number.isInteger(step) || step < 0 || step >= stepCount) {
        issue(issues, "metadata-step", path, "metadata step is outside the pattern");
        continue;
      }
      if ((pattern.rows[padId]?.[step] ?? 0) <= 0) {
        issue(issues, "metadata-inactive-hit", path, "metadata must point to an active drum hit");
      }
      if (
        meta.probability !== undefined &&
        (!Number.isFinite(meta.probability) || meta.probability < 0 || meta.probability > 1)
      ) {
        issue(issues, "metadata-value", `${path}.probability`, "probability must be within 0..1");
      }
      if (meta.ratchet !== undefined && (!Number.isInteger(meta.ratchet) || meta.ratchet < 1 || meta.ratchet > 8)) {
        issue(issues, "metadata-value", `${path}.ratchet`, "ratchet must be an integer within 1..8");
      }
      if (
        meta.microtiming !== undefined &&
        (!Number.isFinite(meta.microtiming) || meta.microtiming < -1 || meta.microtiming > 1)
      ) {
        issue(issues, "metadata-value", `${path}.microtiming`, "microtiming must be within -1..1");
      }
    }
  }

  let previousEnd = -1;
  for (const [index, bar] of (pattern.phrasePlan ?? []).entries()) {
    const path = `phrasePlan.${index}`;
    if (
      !Number.isInteger(bar.bar) ||
      bar.bar < 0 ||
      !Number.isInteger(bar.startStep) ||
      !Number.isInteger(bar.endStep) ||
      bar.startStep < 0 ||
      bar.endStep <= bar.startStep ||
      bar.endStep > stepCount ||
      !PHRASE_SECTIONS.has(bar.section) ||
      bar.startStep < previousEnd
    ) {
      issue(
        issues,
        "phrase-plan",
        path,
        "phrase bars must be ordered, non-overlapping, bounded and use a known section",
      );
    }
    previousEnd = Math.max(previousEnd, bar.endStep);
  }

  const expectedHash = contentHash(canonicalizePattern(doc, pattern));
  if (pattern.generation?.outputContentHash && pattern.generation.outputContentHash !== expectedHash) {
    issue(
      issues,
      "content-hash",
      "generation.outputContentHash",
      "generation output hash does not match musical content",
    );
  }
  if (pattern.assist?.outputContentHash && pattern.assist.outputContentHash !== expectedHash) {
    issue(issues, "content-hash", "assist.outputContentHash", "Assist output hash does not match musical content");
  }

  return { ok: issues.length === 0, issues };
}

export function assertPatternInvariants(
  doc: ProjectDocument,
  pattern: Pattern,
  options: { checkScale?: boolean } = {},
): void {
  const report = inspectPatternInvariants(doc, pattern, options);
  if (!report.ok) {
    throw new Error(
      `Pattern invariant failure: ${report.issues.map((item) => `${item.code}@${item.path}`).join(", ")}`,
    );
  }
}
