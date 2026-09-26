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
 *                    source content. Melodic notes are not role-attributable.
 *
 * Every gate runs AFTER the invariant/repair pass, so a candidate that
 * could not be repaired into brief compliance is dropped, never ranked —
 * the candidate bank cannot contain a result that violates the hard brief.
 *
 * `evaluateBriefCompliance` is the truthful UI mirror: per-fact ✓/✗ for
 * what a pattern can prove, `null` ("·") for what only the plan enforces.
 */
import { drumTrackForTarget, instrumentTrackForRole } from "../ai/role-targets";
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

/**
 * Hard brief violations of one candidate pattern. Pure — runs on the
 * already-invariant-clean (or repaired) candidate. `preservedRoles` is only
 * for a composed iteration that spliced protected source content back in;
 * provider output still uses the stricter default gate.
 */
export function briefGateViolations(
  pattern: Pattern,
  plan: GenerationPlan,
  options: { preservedRoles?: readonly IntentRole[] } = {},
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
  if (source.length !== output.length) return false;
  const counts = new Map<string, number>();
  for (const note of source) {
    const key = noteKey(note);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const note of output) {
    const key = noteKey(note);
    const count = counts.get(key) ?? 0;
    if (count === 0) return false;
    counts.set(key, count - 1);
  }
  return [...counts.values()].every((count) => count === 0);
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
  items.push({
    id: "roles",
    label: `generovať: ${generationRoles.join(", ")}`,
    satisfied: pattern ? hasRowContent(pattern) || hasNoteContent(pattern) : null,
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
