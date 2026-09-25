/**
 * ITERATION (Fáza 3 — AI-first producer): the follow-up prompt as a targeted
 * edit proposal — "ten druhý je lepší, ale temnejší; nechaj bass a akordy".
 *
 * Compiles the session reference (existing resolver) + residual words into
 * ONE auditable proposal against the referenced candidate:
 *
 *   - `patch`      — the CHANGE (mood/energy/bpm/key/… parsed from residual);
 *   - `preserve`   — protected roles (the Fáza 1 preserve clause);
 *   - `targets`    — what regenerates (candidate roles minus preserve);
 *   - splice scope — drum rows are role-attributable, so a drums-only target
 *     splices rows/stepMeta and keeps the candidate's notes byte-identical.
 *     Melodic roles share tracks with no per-note role attribution, so
 *     melodic content regenerates as ONE block or not at all — and when a
 *     melodic role is preserved, the whole melodic block is kept. The
 *     summary SAYS this: the scope of the change is part of the proposal,
 *     never an implicit side effect.
 *
 * The proposal surfaces as a standard 1-candidate GenerationResult: the
 * existing audition, USE, compliance line and stale guard all apply. Accept
 * = the existing apply command = exactly one undo. Rejecting (just not
 * pressing USE) leaves the project untouched. A pure reference ("ten
 * druhý") compiles to null — the panel keeps its instant re-apply.
 *
 * Deterministic: same session + same residual → same content hash.
 */
import { getActivePattern, type Pattern, type ProjectDocument } from "../project-model/types";
import { parseIntentText } from "./text-parser";
import { normalizeIntent } from "./normalize";
import { intentHash } from "./hash";
import { generateLocalResult } from "./pipeline";
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
  /** Roles the iteration explicitly protects. */
  preserve: readonly IntentRole[];
  /** Roles whose content this iteration regenerates. */
  targets: readonly IntentRole[];
  /** Human-readable scope statement — shown with the proposal. */
  summary: string;
  /** Standard applyable result (1-candidate bank) carrying the spliced pattern. */
  result: GenerationResult;
  /** What the project plays NOW — the A/B "original" side. */
  before: Pattern | null;
}

/**
 * Compile an iteration proposal from a referential follow-up. Returns null
 * when the text is not an iteration (no reference, no residual change, or
 * nothing left to regenerate) — callers fall back to their existing paths.
 */
export function compileIteration(
  text: string,
  generation: SessionGeneration,
  doc: ProjectDocument,
): IterationProposal | null {
  const reference = resolveSessionReference(text, generation.candidates);
  if (!reference) return null;
  const candidate = generation.candidates[reference.index];
  const rest = reference.rest.trim();
  if (!rest) return null; // pure "ten druhý" — instant re-apply stays in the panel

  const residual = parseIntentText(rest);
  const patch: IntentInput = {};
  for (const field of PATCH_FIELDS) {
    if (residual.input[field] !== undefined) patch[field] = residual.input[field] as never;
  }
  const preserve = residual.input.preserve ?? [];
  if (Object.keys(patch).length === 0 && preserve.length === 0) return null;

  const baseRoles: readonly IntentRole[] = candidate.intent.roles ?? ["drums", "bass"];
  // Role directives in the residual OVERRIDE the candidate's roles —
  // "žiadne bicie" on a drum-carrying candidate means the iteration drops
  // them, not that it regenerates them.
  const effectiveRoles: readonly IntentRole[] = residual.input.roles ?? baseRoles;
  const drumTarget = effectiveRoles.includes("drums") && !preserve.includes("drums");
  const melodicTargeted = MELODIC_ROLES.some((role) => effectiveRoles.includes(role) && !preserve.includes(role));
  const melodicPreserved = MELODIC_ROLES.some((role) => preserve.includes(role));
  // Melodic roles share tracks — a preserved melodic role keeps the WHOLE
  // melodic block (stated in the summary, never silent).
  const melodicRegen = melodicTargeted && !melodicPreserved;
  if (!drumTarget && !melodicRegen) return null;
  const targets: IntentRole[] = [
    ...(drumTarget ? (["drums"] as const) : []),
    ...(melodicRegen ? MELODIC_ROLES.filter((role) => effectiveRoles.includes(role)) : []),
  ];

  // Length changes reshape everything — splice is meaningless across
  // different stepCounts, so a length patch regenerates the WHOLE candidate
  // idea at the new length instead of splicing.
  const fullRegen = patch.length !== undefined && patch.length !== candidate.pattern.stepCount;

  const mergedIntent = normalizeIntent({
    ...candidate.intent,
    ...patch,
    preserve,
    ...(residual.input.roles ? { roles: residual.input.roles } : {}),
  });
  const iterSeed = `${candidate.intent.seed.split("|")[0]}|iteration`;
  const regenIntent = normalizeIntent({
    ...mergedIntent,
    roles: fullRegen ? mergedIntent.roles : targets,
    seed: iterSeed,
    candidateCount: 1,
  });
  const generated = generateLocalResult(doc, regenIntent, "preview");
  // A rejected/fallback inner generation is not an iteration proposal — the
  // panel falls back to its existing paths instead of presenting junk.
  if (!generated.proposal || (generated.status !== "accepted" && generated.status !== "repaired")) return null;
  const regenerated = generated.proposal.pattern;

  const spliced: Pattern = fullRegen
    ? regenerated
    : {
        ...candidate.pattern,
        ...(drumTarget
          ? {
              rows: regenerated.rows,
              ...(regenerated.stepMeta !== undefined ? { stepMeta: regenerated.stepMeta } : {}),
            }
          : {}),
        ...(melodicRegen ? { notes: regenerated.notes } : {}),
      };

  const plan = {
    ...generated.plan,
    intent: mergedIntent,
    intentHash: intentHash(mergedIntent),
  };
  const diagnostics = {
    ...generated.diagnostics,
    warnings: [
      ...generated.diagnostics.warnings,
      `iteration:source:candidate-${reference.index}`,
      `iteration:targets:${targets.join("+")}`,
      `iteration:preserve:${preserve.length > 0 ? preserve.join("+") : "none"}`,
    ],
  };
  const result: GenerationResult = {
    status: generated.status,
    plan,
    proposal: { pattern: spliced, diagnostics, status: generated.status },
    diagnostics,
    provider: generated.provider,
    bank: [
      {
        candidateIndex: 0,
        seed: iterSeed,
        source: "template",
        status: generated.status,
        repairs: generated.diagnostics.repairs,
        score: 0,
        modelScore: null,
        contentHash: "",
        pattern: spliced,
      },
    ],
    selection: generated.selection,
  };

  const scopeParts: string[] = [];
  if (drumTarget) scopeParts.push("bicie regenerované");
  if (melodicRegen) scopeParts.push("melodika regenerovaná");
  else if (melodicTargeted) scopeParts.push("melodika ponechaná (chránená rola zdieľa track)");
  if (patch.mood) scopeParts.push(`nálada: ${patch.mood}`);
  if (patch.energy !== undefined) scopeParts.push(`energia ${Math.round(patch.energy * 100)} %`);
  if (patch.bpmRange)
    scopeParts.push(
      `${patch.bpmRange[0] === patch.bpmRange[1] ? patch.bpmRange[0] : `${patch.bpmRange[0]}–${patch.bpmRange[1]}`} BPM`,
    );
  if (patch.key) scopeParts.push(`tónina ${patch.key}`);
  const summary =
    `iterácia #${reference.index + 1}: ${scopeParts.join(" · ")}` +
    (preserve.length > 0 ? ` · ponechané: ${preserve.join(", ")}` : "");

  return {
    referenceIndex: reference.index,
    patch,
    preserve,
    targets,
    summary,
    result,
    before: getActivePattern(doc),
  };
}
