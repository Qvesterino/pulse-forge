/**
 * ITERATION (Fáza 3 — AI-first producer): compile a conversational follow-up
 * into one auditable proposal against the referenced session candidate.
 * Protected content is copied from that candidate, not silently regenerated.
 */
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { STEP_TICKS, type NoteEvent, type Pattern, type ProjectDocument } from "../project-model/types";
import { uid } from "../shared/ids";
import { hashString } from "../shared/rng";
import { briefGateViolations } from "./brief-gate";
import { scoreCandidate } from "./candidate-bank";
import { parseIntentText } from "./text-parser";
import { normalizeIntent } from "./normalize";
import { generateLocalResult } from "./pipeline";
import { refreshPatternOutputHash, refreshPatternQuality } from "./quality";
import { resolveSessionReference, type SessionGeneration } from "./session-context";
import type { GenerationResult, IntentInput, IntentRole } from "./types";

const MELODIC_ROLES: readonly IntentRole[] = ["bass", "chords", "lead"];

/** Intent fields that constitute a CHANGE request in the residual. */
const PATCH_FIELDS = [
  "mood",
  "energy",
  "density",
  "complexity",
  "variation",
  "bpmRange",
  "key",
  "style",
  "length",
] as const;

export interface IterationProposal {
  /** Referenced candidate index in the session generation. */
  referenceIndex: number;
  /** The CHANGE fields parsed from the residual prompt. */
  patch: IntentInput;
  /** Roles this iteration explicitly protects and carries forward. */
  preserve: readonly IntentRole[];
  /** Roles whose content this iteration regenerates. */
  targets: readonly IntentRole[];
  /** Human-readable scope statement — shown with the proposal. */
  summary: string;
  /** Standard applyable result (1-candidate bank) carrying the composed pattern. */
  result: GenerationResult;
  /** What the project plays NOW — the A/B "original" side. */
  before: Pattern | null;
}

function hasDrumContent(pattern: Pattern): boolean {
  return Object.values(pattern.rows ?? {}).some(
    (row) => Array.isArray(row) && row.some((value) => Number.isFinite(value) && value > 0),
  );
}

function resizeRows(rows: Pattern["rows"], stepCount: number): Pattern["rows"] {
  return Object.fromEntries(
    Object.entries(rows ?? {}).map(([padId, values]) => [
      padId,
      Array.from({ length: stepCount }, (_, step) => values[step] ?? 0),
    ]),
  );
}

function resizeStepMeta(pattern: Pattern, rows: Pattern["rows"], stepCount: number): Pattern["stepMeta"] {
  const stepMeta: NonNullable<Pattern["stepMeta"]> = {};
  for (const [padId, steps] of Object.entries(pattern.stepMeta ?? {})) {
    for (const [rawStep, meta] of Object.entries(steps)) {
      const step = Number(rawStep);
      if (!Number.isInteger(step) || step < 0 || step >= stepCount || (rows[padId]?.[step] ?? 0) <= 0) continue;
      (stepMeta[padId] ??= {})[step] = {
        ...meta,
        ...(meta.locks ? { locks: { ...meta.locks } } : {}),
      };
    }
  }
  return Object.keys(stepMeta).length > 0 ? stepMeta : undefined;
}

function resizeNotes(notes: Pattern["notes"], stepCount: number): Pattern["notes"] {
  const maxTicks = stepCount * STEP_TICKS;
  const resized: NonNullable<Pattern["notes"]> = {};
  for (const [trackId, trackNotes] of Object.entries(notes ?? {})) {
    const kept: NoteEvent[] = [];
    for (const note of trackNotes) {
      if (note.start >= maxTicks) continue;
      kept.push({
        ...note,
        duration: Math.max(1, Math.min(note.duration, maxTicks - note.start)),
        ...(note.locks ? { locks: { ...note.locks } } : {}),
      });
    }
    resized[trackId] = kept;
  }
  return resized;
}

function withFreshIdentityIfAlreadyApplied(pattern: Pattern, doc: ProjectDocument): Pattern {
  if (!doc.patterns.some((existing) => existing.id === pattern.id)) return pattern;
  return {
    ...pattern,
    id: uid("pattern"),
    notes: Object.fromEntries(
      Object.entries(pattern.notes ?? {}).map(([trackId, notes]) => [
        trackId,
        notes.map((note) => ({ ...note, id: uid("note") })),
      ]),
    ),
  };
}

function rejectedResult(generated: GenerationResult, reason: string): GenerationResult {
  return {
    ...generated,
    status: "rejected",
    proposal: undefined,
    bank: [],
    diagnostics: {
      ...generated.diagnostics,
      errors: [...generated.diagnostics.errors, reason],
      warnings: [...generated.diagnostics.warnings, "iteration:rejected"],
    },
  };
}

/**
 * Compile a referential follow-up into a targeted proposal. Returns null only
 * when it is not a supported edit (or is a pure reference); a recognized edit
 * that fails generation returns a rejected result, never a silent re-apply.
 */
export function compileIteration(
  text: string,
  generation: SessionGeneration,
  doc: ProjectDocument,
): IterationProposal | null {
  if (generation.docId !== doc.id) return null;
  const reference = resolveSessionReference(text, generation.candidates);
  if (!reference) return null;
  const candidate = generation.candidates[reference.index];
  if (!candidate) return null;
  const rest = reference.rest.trim();
  if (!rest) return null; // pure "ten druhý" — instant re-apply stays in the panel

  const residual = parseIntentText(rest);
  const patch: IntentInput = {};
  for (const field of PATCH_FIELDS) {
    if (residual.input[field] !== undefined) patch[field] = residual.input[field] as never;
  }
  const requestedPreserve = residual.input.preserve ?? [];
  const explicitNoDrums = residual.detected.includes("no drums");
  // A hard "no drums" prohibition wins over a contradictory keep request.
  const preserve = explicitNoDrums ? requestedPreserve.filter((role) => role !== "drums") : requestedPreserve;
  const baseRoles: readonly IntentRole[] = candidate.intent.roles ?? ["drums", "bass"];
  const effectiveRoles: readonly IntentRole[] = residual.input.roles ?? baseRoles;
  const fullRegen = patch.length !== undefined && patch.length !== candidate.pattern.stepCount;
  const drumTarget = effectiveRoles.includes("drums") && !preserve.includes("drums") && !explicitNoDrums;
  const drumRemoval = explicitNoDrums && hasDrumContent(candidate.pattern);
  const melodicPreserved = MELODIC_ROLES.some((role) => preserve.includes(role));
  const melodicTargeted = MELODIC_ROLES.some((role) => effectiveRoles.includes(role) && !preserve.includes(role));
  // Melodic roles share tracks: preserving any one protects the whole block.
  const melodicRegen = melodicTargeted && !melodicPreserved;
  const targets: IntentRole[] = fullRegen
    ? effectiveRoles.filter((role) => !preserve.includes(role) && !(melodicPreserved && MELODIC_ROLES.includes(role)))
    : [
        ...(drumTarget ? (["drums"] as const) : []),
        ...(melodicRegen ? MELODIC_ROLES.filter((r) => effectiveRoles.includes(r)) : []),
      ];

  if (Object.keys(patch).length === 0 && preserve.length === 0 && !explicitNoDrums) return null;
  if (targets.length === 0 && !drumRemoval && !fullRegen && Object.keys(patch).length === 0) return null;

  const mergedIntent = normalizeIntent({
    ...candidate.intent,
    ...patch,
    preserve,
    ...(residual.input.roles ? { roles: residual.input.roles } : {}),
  });
  const candidateSeed = candidate.pattern.generation?.seed ?? candidate.intent.seed;
  const candidateHash = contentHash(canonicalizePattern(doc, candidate.pattern));
  const iterSeed = `${candidateSeed.slice(0, 72)}|iter:${hashString(`${candidateSeed}|${candidateHash}`).toString(36)}`;
  const regenIntent = normalizeIntent({
    ...mergedIntent,
    // The generator sees only regenerated roles. Preserved content is spliced
    // back from the referenced candidate below.
    roles: targets.length > 0 ? targets : mergedIntent.roles,
    preserve,
    seed: iterSeed,
    sourcePatternId: candidate.pattern.id,
    candidateCount: 1,
  });

  // Make the referenced in-memory candidate available to the normal source-
  // pattern seed/provenance path even when it has not been applied yet.
  const sourceDoc: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns.filter((pattern) => pattern.id !== candidate.pattern.id), candidate.pattern],
  };
  const generated = generateLocalResult(sourceDoc, regenIntent, "preview");
  const scope = `iterácia #${reference.index + 1}`;
  if (targets.length === 0 && !drumRemoval && !fullRegen && Object.keys(patch).length > 0) {
    const reason = "požadovaná zmena nemá regenerovateľnú rolu — chránený obsah zostal nedotknutý";
    return {
      referenceIndex: reference.index,
      patch,
      preserve,
      targets,
      summary: `${scope} odmietnutá: ${reason}`,
      result: rejectedResult(generated, `iteration:no-editable-target:${reason}`),
      before: candidate.pattern,
    };
  }
  if (!generated.proposal || (generated.status !== "accepted" && generated.status !== "repaired")) {
    const reason =
      generated.diagnostics.errors[0] ?? generated.diagnostics.fallbackReason ?? "generovanie návrhu zlyhalo";
    return {
      referenceIndex: reference.index,
      patch,
      preserve,
      targets,
      summary: `${scope} odmietnutá: ${reason}`,
      result: rejectedResult(generated, `iteration: ${reason}`),
      before: candidate.pattern,
    };
  }

  const regenerated = generated.proposal.pattern;
  let composed: Pattern;
  if (fullRegen) {
    composed = { ...regenerated };
    if (preserve.includes("drums") && !explicitNoDrums) {
      const rows = resizeRows(candidate.pattern.rows, regenerated.stepCount);
      composed = {
        ...composed,
        rows,
        stepMeta: resizeStepMeta(candidate.pattern, rows, regenerated.stepCount),
      };
    }
    if (melodicPreserved)
      composed = { ...composed, notes: resizeNotes(candidate.pattern.notes, regenerated.stepCount) };
  } else {
    composed = {
      ...candidate.pattern,
      generation: regenerated.generation,
      ...(drumTarget
        ? {
            rows: regenerated.rows,
            ...(regenerated.stepMeta !== undefined ? { stepMeta: regenerated.stepMeta } : { stepMeta: undefined }),
          }
        : {}),
      ...(drumRemoval ? { rows: {}, stepMeta: undefined } : {}),
      ...(melodicRegen ? { notes: regenerated.notes } : {}),
    };
  }

  composed = withFreshIdentityIfAlreadyApplied(composed, doc);
  const measured = refreshPatternQuality(sourceDoc, composed, generated.plan.options);
  const finalPattern = refreshPatternOutputHash(sourceDoc, measured);
  const violations = briefGateViolations(finalPattern, generated.plan, { preservedRoles: preserve });
  if (violations.length > 0) {
    const reason = violations.map((violation) => `${violation.id}: ${violation.detail}`).join("; ");
    return {
      referenceIndex: reference.index,
      patch,
      preserve,
      targets,
      summary: `${scope} odmietnutá: výsledok nespĺňa brief (${reason})`,
      result: rejectedResult(generated, `iteration:brief-gate:${reason}`),
      before: candidate.pattern,
    };
  }

  const warnings = [
    ...generated.diagnostics.warnings,
    `iteration:source:candidate-${reference.index}`,
    `iteration:targets:${targets.join("+") || "none"}`,
    `iteration:preserve:${preserve.length > 0 ? preserve.join("+") : "none"}`,
    ...(drumRemoval ? ["iteration:removed:drums"] : []),
    ...(explicitNoDrums && requestedPreserve.includes("drums")
      ? ["iteration:conflict:no-drums-overrides-preserve"]
      : []),
    ...(fullRegen ? ["iteration:full-regen:length"] : []),
  ];
  const diagnostics = {
    ...generated.diagnostics,
    warnings,
  };
  const result: GenerationResult = {
    status: generated.status,
    plan: generated.plan,
    proposal: { pattern: finalPattern, diagnostics, status: generated.status },
    diagnostics,
    provider: generated.provider,
    bank: [
      {
        candidateIndex: 0,
        seed: iterSeed,
        source: "template",
        status: generated.status,
        repairs: generated.diagnostics.repairs,
        score: scoreCandidate(finalPattern),
        modelScore: null,
        contentHash: contentHash(canonicalizePattern(sourceDoc, finalPattern)),
        pattern: finalPattern,
      },
    ],
    selection: generated.selection,
  };

  const scopeParts: string[] = [];
  if (drumTarget) scopeParts.push("bicie regenerované");
  if (drumRemoval) scopeParts.push("bicie odstránené");
  if (melodicRegen) scopeParts.push("melodika regenerovaná");
  else if (melodicTargeted || melodicPreserved) scopeParts.push("melodika ponechaná (chránená rola zdieľa track)");
  if (fullRegen) scopeParts.push(`dĺžka ${regenerated.stepCount} krokov`);
  if (patch.mood) scopeParts.push(`nálada: ${patch.mood}`);
  if (patch.energy !== undefined) scopeParts.push(`energia ${Math.round(patch.energy * 100)} %`);
  if (patch.bpmRange)
    scopeParts.push(
      `${patch.bpmRange[0] === patch.bpmRange[1] ? patch.bpmRange[0] : `${patch.bpmRange[0]}–${patch.bpmRange[1]}`} BPM`,
    );
  if (patch.key) scopeParts.push(`tónina ${patch.key}`);
  if (fullRegen && melodicPreserved) scopeParts.push("chránená melodika orezaná/prispôsobená dĺžke");
  if (fullRegen && preserve.includes("drums") && !explicitNoDrums) scopeParts.push("chránené bicie prispôsobené dĺžke");
  const summary =
    `${scope}: ${scopeParts.join(" · ")}` + (preserve.length > 0 ? ` · ponechané: ${preserve.join(", ")}` : "");

  return {
    referenceIndex: reference.index,
    patch,
    preserve,
    targets,
    summary,
    result,
    before: candidate.pattern,
  };
}
