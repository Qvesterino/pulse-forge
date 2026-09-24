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
 *   - `prohibited` — drum-row content while the drums role is excluded from
 *                    the generation set (ZÁKAZY "no drums" / ZACHOVAŤ
 *                    "keep my drums"). Drum rows are role-attributable;
 *                    melodic notes are not (bass/chords/lead share tracks),
 *                    so the melodic side stays plan-enforced.
 *
 * Every gate runs AFTER the invariant/repair pass, so a candidate that
 * could not be repaired into brief compliance is dropped, never ranked —
 * the candidate bank cannot contain a result that violates the hard brief.
 *
 * `evaluateBriefCompliance` is the truthful UI mirror: per-fact ✓/✗ for
 * what a pattern can prove, `null` ("·") for what only the plan enforces.
 */
import type { Pattern } from "../project-model/types";
import type { GenerationPlan, GenerationResult } from "./types";

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
 * already-invariant-clean (or repaired) candidate.
 */
export function briefGateViolations(pattern: Pattern, plan: GenerationPlan): BriefViolation[] {
  const violations: BriefViolation[] = [];
  if (pattern.stepCount !== plan.options.stepCount) {
    violations.push({
      id: "length",
      detail: `stepCount ${pattern.stepCount} != planned ${plan.options.stepCount}`,
    });
  }
  const generationRoles = plan.options.roles ?? [];
  if (!generationRoles.includes("drums") && hasRowContent(pattern)) {
    violations.push({
      id: "prohibited-drums",
      detail: "drum rows carry content while drums are excluded (prohibition/preserve)",
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
export function evaluateBriefCompliance(result: GenerationResult): readonly BriefComplianceItem[] {
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

  if (!generationRoles.includes("drums")) {
    items.push({
      id: "no-drums",
      label: "žiadne bicie",
      satisfied: pattern ? !hasRowContent(pattern) : null,
    });
  }

  if (intent.preserve && intent.preserve.length > 0) {
    const drumsPreserved = intent.preserve.includes("drums");
    items.push({
      id: "preserve",
      label: `ponechané: ${intent.preserve.join(", ")}`,
      satisfied: pattern ? (drumsPreserved ? !hasRowContent(pattern) : true) : null,
      detail: drumsPreserved ? undefined : "vynútené plánom",
    });
  }

  return items;
}
