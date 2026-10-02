/**
 * BRIEF GATE + COMPLIANCE (Fáza 2 — AI-first producer roadmap).
 *
 * Hard brief constraints travel at PLAN level (bpmRange, key, length, roles,
 * preserve) — every candidate inherits them from its plan. What a CANDIDATE
 * can still violate is its own content:
 *
 *   - `length`     — pattern stepCount diverging from the planned length;
 *   - `empty`      — a degenerate all-silent candidate (structurally valid,
 *                    musically useless — invariants pass it, this gate must
 *                    not);
 *   - `prohibited` — drum-row content while drums are excluded, unless the
 *                    caller explicitly identifies those rows as protected
 *                    source content; and melodic notes on an unambiguous
 *                    instrument lane whose role is outside the generation set.
 *
 * Every gate runs AFTER the invariant/repair pass, so a candidate that
 * could not be repaired into brief compliance is dropped, never ranked —
 * the candidate bank cannot contain a result that violates the hard brief.
 *
 * `evaluateBriefCompliance` is the truthful UI mirror: per-fact ✓/✗ for
 * what a pattern can prove, `null` ("·") for what only the plan enforces.
 */
import { drumTrackForTarget, instrumentTrackForRole, type MelodicRole } from "../ai/role-targets";
import type { NoteEvent, Pattern, ProjectDocument } from "../project-model/types";
import type { GenerationPlan, GenerationResult, IntentRole } from "./types";

export interface BriefViolation {
  id: string;
  detail: string;
}

/** Non-zero drum content — a step with finite velocity > 0. */
export function hasRowContent(pattern: Pattern): boolean {
  return Object.values(pattern.rows ?? {}).some(
    (row) => Array.isArray(row) && row.some((value) => Number.isFinite(value) && value > 0),
  );
}

/** Any melodic note on any instrument track. */
export function hasNoteContent(pattern: Pattern): boolean {
  return Object.values(pattern.notes ?? {}).some((notes) => Array.isArray(notes) && notes.length > 0);
}

const MELODIC_TARGET: Readonly<Partial<Record<IntentRole, MelodicRole>>> = {
  bass: "bass",
  chords: "chord",
  lead: "lead",
};

function melodicRoleTracks(project: ProjectDocument, plan: GenerationPlan): Map<IntentRole, string> {
  const tracks = new Map<IntentRole, string>();
  for (const [role, target] of Object.entries(MELODIC_TARGET) as [IntentRole, MelodicRole][]) {
    const track = instrumentTrackForRole(project, target, plan.options.instrumentTrackIds);
    if (track) tracks.set(role, track.id);
  }
  return tracks;
}

function melodicTrackOwners(tracks: ReadonlyMap<IntentRole, string>): Map<string, IntentRole[]> {
  const owners = new Map<string, IntentRole[]>();
  for (const [role, trackId] of tracks) owners.set(trackId, [...(owners.get(trackId) ?? []), role]);
  return owners;
}

function hasTrackNotes(pattern: Pattern, trackId: string): boolean {
  const notes = pattern.notes?.[trackId];
  return Array.isArray(notes) && notes.length > 0;
}

/**
 * Hard brief violations of one candidate pattern. Pure — runs on the
 * already-invariant-clean (or repaired) candidate. `preservedRoles` is only
 * for a composed iteration that spliced protected source content back in;
 * provider output still uses the stricter default gate.
 */
export function briefGateViolations(
  pattern: Pattern,
  plan: GenerationPlan,
  options: { preservedRoles?: readonly IntentRole[]; project?: ProjectDocument } = {},
): BriefViolation[] {
  const violations: BriefViolation[] = [];
  if (pattern.stepCount !== plan.options.stepCount) {
    violations.push({
      id: "length",
      detail: `stepCount ${pattern.stepCount} != planned ${plan.options.stepCount}`,
    });
  }
  const generationRoles = plan.options.roles ?? [];
  if (!generationRoles.includes("drums") && !options.preservedRoles?.includes("drums") && hasRowContent(pattern)) {
    violations.push({
      id: "prohibited-drums",
      detail: "drum rows carry content while drums are excluded",
    });
  }
  if (options.project) {
    const roleTracks = melodicRoleTracks(options.project, plan);
    const ownersByTrack = melodicTrackOwners(roleTracks);
    const allowedRoles = new Set([...generationRoles, ...(options.preservedRoles ?? plan.intent.preserve ?? [])]);
    for (const [trackId, notes] of Object.entries(pattern.notes ?? {})) {
      if (!Array.isArray(notes) || notes.length === 0) continue;
      const track = options.project.tracks.find((candidate) => candidate.id === trackId);
      if (!track || track.kind !== "instrument") {
        violations.push({
          id: "unexpected-note-track",
          detail: `notes target a non-instrument or unknown track ${trackId}`,
        });
        continue;
      }
      const owners = ownersByTrack.get(trackId) ?? [];
      const allowedOwners = owners.filter((role) => allowedRoles.has(role));
      if (allowedOwners.length > 0) continue;
      if (owners.length === 1) {
        violations.push({
          id: `unexpected-role-${owners[0]}`,
          detail: `track ${trackId} contains ${owners[0]} notes outside the generation/preserve scope`,
        });
      } else {
        violations.push({
          id: "unexpected-role-content",
          detail:
            owners.length > 1
              ? `track ${trackId} contains notes for excluded roles ${owners.join(", ")}`
              : `track ${trackId} is not mapped to a generated or preserved melodic role`,
        });
      }
    }
  }
  if (!hasRowContent(pattern) && !hasNoteContent(pattern)) {
    violations.push({ id: "empty", detail: "candidate has no drum or note content" });
  }
  return violations;
}

// ── Compliance report (UI mirror of the hard facts) ───────────────────────

export interface BriefComplianceItem {
  id: string;
  /** Short SK label — the same phrasing the brief contract uses. */
  label: string;
  /** true/false provable from the pattern; null = plan-enforced or unset. */
  satisfied: boolean | null;
  detail?: string;
}

const stepCountLabel = (steps: number): string => `${steps / 16} taktov`;

/**
 * Per-fact compliance of a generation result's selected pattern against its
 * own plan. Never a quality judgement — only the hard brief facts, with
 * `null` where the pattern cannot prove anything.
 */
function sameArray(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function metadataKey(value: Record<string, unknown> | undefined, stepCount: number): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value ?? {})
        .filter(([step]) => Number(step) < stepCount)
        .sort(([a], [b]) => Number(a) - Number(b)),
    ),
  );
}

function noteKey(note: NoteEvent): string {
  return JSON.stringify([
    note.pitch,
    note.start,
    note.duration,
    note.velocity,
    note.slide ?? false,
    note.locks ?? null,
  ]);
}

function sourceNotesRemain(source: readonly NoteEvent[], output: readonly NoteEvent[]): boolean {
  const counts = new Map<string, number>();
  for (const note of output) {
    const key = noteKey(note);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const note of source) {
    const key = noteKey(note);
    const count = counts.get(key) ?? 0;
    if (count === 0) return false;
    counts.set(key, count - 1);
  }
  return true;
}

function preservedContentSatisfied(result: GenerationResult, doc: ProjectDocument): boolean {
  const pattern = result.proposal?.pattern;
  if (!pattern) return false;
  const sourceId = result.plan.preserveSourcePatternId ?? result.plan.intent.sourcePatternId;
  const source = doc.patterns.find((candidate) => candidate.id === sourceId);
  if (!source) return false;

  for (const role of result.plan.intent.preserve ?? []) {
    if (role === "drums") {
      const drumTrack = drumTrackForTarget(doc, result.plan.options.drumTrackId);
      if (!drumTrack) return false;
      for (const pad of drumTrack.pads) {
        const sourceRow = source.rows[pad.id] ?? [];
        if (sourceRow.slice(pattern.stepCount).some((velocity) => velocity > 0)) return false;
        const expected = Array.from({ length: pattern.stepCount }, (_, index) => sourceRow[index] ?? 0);
        const actual = Array.from({ length: pattern.stepCount }, (_, index) => pattern.rows[pad.id]?.[index] ?? 0);
        if (!sameArray(expected, actual)) return false;
        if (
          metadataKey(source.stepMeta?.[pad.id], pattern.stepCount) !==
          metadataKey(pattern.stepMeta?.[pad.id], pattern.stepCount)
        )
          return false;
      }
      continue;
    }

    const melodicRole = role === "chords" ? "chord" : role;
    if (melodicRole !== "bass" && melodicRole !== "chord" && melodicRole !== "lead") continue;
    const track = instrumentTrackForRole(doc, melodicRole, result.plan.options.instrumentTrackIds);
    if (!track) return false;
    if (!sourceNotesRemain(source.notes[track.id] ?? [], pattern.notes[track.id] ?? [])) return false;
  }
  return true;
}

export function evaluateBriefCompliance(
  result: GenerationResult,
  sourceProject?: ProjectDocument,
): readonly BriefComplianceItem[] {
  const intent = result.plan.intent;
  const pattern = result.proposal?.pattern ?? null;
  const items: BriefComplianceItem[] = [];

  const bpm = result.plan.resolvedBpm;
  if (intent.bpmRange) {
    const [lo, hi] = intent.bpmRange;
    items.push({
      id: "bpm",
      label: lo === hi ? `${lo} BPM` : `${lo}–${hi} BPM`,
      satisfied: bpm !== null && bpm >= lo && bpm <= hi,
      ...(bpm !== null && bpm !== hi ? { detail: `${bpm} BPM` } : {}),
    });
  } else {
    items.push({ id: "bpm", label: "tempo", satisfied: null, detail: "zvolí groove" });
  }

  items.push(
    pattern
      ? { id: "length", label: stepCountLabel(intent.length), satisfied: pattern.stepCount === intent.length }
      : { id: "length", label: stepCountLabel(intent.length), satisfied: null },
  );

  items.push(
    intent.key
      ? {
          id: "key",
          label: `tónina ${intent.key}`,
          satisfied: result.plan.options.key === intent.key,
        }
      : { id: "key", label: "tónina", satisfied: null, detail: "nezadaná" },
  );

  const generationRoles = result.plan.options.roles ?? [];
  const roleDetails: string[] = [];
  let roleCompliance: boolean | null = pattern ? true : null;
  if (pattern && generationRoles.length === 0) {
    roleCompliance = null;
    roleDetails.push("nič sa negeneruje; zachovaný obsah sa kontroluje samostatne");
  } else if (pattern && sourceProject) {
    const roleTracks = melodicRoleTracks(sourceProject, result.plan);
    const ownersByTrack = melodicTrackOwners(roleTracks);
    const checks = generationRoles.map((role) => {
      if (role === "drums") {
        const drumTrack = drumTrackForTarget(sourceProject, result.plan.options.drumTrackId);
        const hasTargetRows =
          drumTrack?.pads.some((pad) =>
            pattern.rows[pad.id]?.some((velocity) => Number.isFinite(velocity) && velocity > 0),
          ) ?? false;
        roleDetails.push(`bicie ${hasTargetRows ? "✓" : "✗"}`);
        return hasTargetRows;
      }
      const trackId = roleTracks.get(role);
      if (!trackId) {
        roleDetails.push(`${role} — track chýba`);
        return false;
      }
      if ((ownersByTrack.get(trackId)?.length ?? 0) > 1) {
        roleDetails.push(`${role} — zdieľaný track, nemožno samostatne overiť`);
        return null;
      }
      const hasNotes = hasTrackNotes(pattern, trackId);
      roleDetails.push(`${role} ${hasNotes ? "✓" : "✗"}`);
      return hasNotes;
    });
    roleCompliance = checks.some((check) => check === false)
      ? false
      : checks.some((check) => check === null)
        ? null
        : true;
  } else if (pattern) {
    roleCompliance = null;
  }
  items.push({
    id: "roles",
    label: `generovať: ${generationRoles.join(", ")}`,
    satisfied: roleCompliance,
    ...(roleDetails.length > 0 ? { detail: roleDetails.join(" · ") } : {}),
  });

  const drumsPreserved = intent.preserve?.includes("drums") ?? false;
  if (!generationRoles.includes("drums") && !drumsPreserved) {
    items.push({
      id: "no-drums",
      label: "žiadne bicie",
      satisfied: pattern ? !hasRowContent(pattern) : null,
    });
  }

  if (intent.preserve && intent.preserve.length > 0) {
    const preserved = sourceProject ? preservedContentSatisfied(result, sourceProject) : null;
    items.push({
      id: "preserve",
      label: `ponechané: ${intent.preserve.join(", ")}`,
      satisfied: pattern ? preserved : null,
      detail:
        preserved === true
          ? "UUID-free obsah zdrojových rolí je v návrhu zachovaný"
          : preserved === false
            ? "zdrojový obsah alebo track chýba, prípadne sa líši od návrhu"
            : "zdrojový projekt nie je dostupný na overenie",
    });
  }

  return items;
}
