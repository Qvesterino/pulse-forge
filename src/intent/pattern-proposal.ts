import { drumTrackForTarget, instrumentTrackForRole } from "../ai/role-targets";
import { inspectPatternInvariants } from "../ai/invariants";
import { deepEqualRef } from "../commands/docDelta";
import { resolveExactTargetTracks } from "../commands/intentRouting";
import { STEP_TICKS, type NoteEvent, type Pattern, type ProjectDocument } from "../project-model/types";
import { checkProposalConstraints, type ProposalConstraints } from "./proposal-constraints";
import type { GenerationPlan, GenerationResult, IntentRole } from "./types";

/** Pattern variant of the shared proposal envelope; no audio verdict is implied. */
export interface PatternMusicalProposalV1 {
  schema: "kyx.musical-proposal";
  version: 1;
  kind: "pattern";
  id: string;
  base: { projectId: string; revision: number | null; freshness: "current" | "unknown" };
  scope: { sourcePatternId: string; targetTrackIds: string[]; audition: null; writeScope: "declared" };
  intent: {
    label: string;
    goals: string[];
    interpreter: "intent_engine";
    roles: IntentRole[];
    preserve: IntentRole[];
  };
  /** The precise generated plan, including targets, tempo and optional FX. */
  executionPlan: GenerationPlan;
  constraints: { status: "declared"; rules: ProposalConstraints };
  candidates: Array<{ id: string; pattern: Pattern }>;
  evidence: Array<{
    id: "source-pattern";
    kind: "project_fact" | "session_candidate";
    sourcePatternId: string;
    sourcePattern?: Pattern;
  }>;
  checks: { structural: "verified"; acoustic: "not_measured"; subjective: "not_judged" };
  warnings: string[];
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Resolve roles without the generator's positional fallback silently choosing
 * one of several possible user-owned tracks. */
export function patternProtectionScope(doc: ProjectDocument, plan: GenerationPlan): Result<ProposalConstraints> {
  const protect: ProposalConstraints["protect"] = [];
  // A PRESERVE rule protects the project's tempo, meter and groove — the
  // generated pattern must not silently move them. But an EXPLICIT tempo
  // request is not a violation of that protection: it IS the request. The
  // saved Producer Brief can hold both at once ("keep my bass" AND "140 bpm"),
  // and protecting the tempo there refuses the very edit the user confirmed.
  const explicitTempo = plan.intent.bpmRange != null;
  if (plan.intent.preserve?.length) {
    if (!explicitTempo) protect.push(["bpm"]);
    protect.push(["timeSignature"], ["groove"]);
  }
  for (const role of plan.intent.preserve ?? []) {
    if (role === "drums") {
      const drums = doc.tracks.filter((track) => track.kind === "drum");
      const requested = plan.options.drumTrackId;
      if (requested && !drums.some((track) => track.id === requested))
        return { ok: false, reason: `Protected drum track ${requested} no longer exists.` };
      if (!requested && drums.length !== 1)
        return {
          ok: false,
          reason: `Choose one drum track to preserve: ${drums.map((track) => `${track.name} [${track.id}]`).join(", ") || "no drum track exists"}.`,
        };
      const track = drumTrackForTarget(doc, requested);
      if (!track) return { ok: false, reason: "Protected drums have no source track." };
      protect.push(["tracks", { id: track.id }]);
      continue;
    }
    const family = role === "chords" ? "chords" : role;
    const explicit = plan.options.instrumentTrackIds;
    const matching = resolveExactTargetTracks(doc, family).filter((id) => !explicit?.length || explicit.includes(id));
    if (matching.length !== 1)
      return {
        ok: false,
        reason: `Choose one ${role} track to preserve: ${matching.map((id) => `${doc.tracks.find((track) => track.id === id)?.name ?? id} [${id}]`).join(", ") || "no matching track exists"}.`,
      };
    const mapped = instrumentTrackForRole(doc, role === "chords" ? "chord" : role, explicit);
    if (!mapped || mapped.id !== matching[0])
      return { ok: false, reason: `The ${role} source is ambiguous; select the exact track before generating.` };
    protect.push(["tracks", { id: mapped.id }]);
  }
  return { ok: true, value: { protect } };
}

function sameNote(a: NoteEvent, b: NoteEvent): boolean {
  const { id: _a, ...left } = a;
  const { id: _b, ...right } = b;
  return deepEqualRef(left, right);
}

/** Verify actual candidate content independently of a provider's self-report. */
export function checkPatternPreservation(
  doc: ProjectDocument,
  plan: GenerationPlan,
  pattern: Pattern,
  preservationSource?: Pattern,
): Result<ProposalConstraints> {
  const scope = patternProtectionScope(doc, plan);
  if (!scope.ok) return scope;
  const roles = plan.intent.preserve ?? [];
  if (!roles.length) return scope;
  const sourceId = plan.preserveSourcePatternId ?? plan.intent.sourcePatternId;
  const projectSource = doc.patterns.find((item) => item.id === sourceId);
  if (preservationSource && preservationSource.id !== sourceId)
    return { ok: false, reason: "The preserved session candidate has the wrong source ID." };
  if (projectSource && preservationSource && !deepEqualRef(projectSource, preservationSource))
    return { ok: false, reason: "The preserved source pattern changed; regenerate the proposal." };
  const source = projectSource ?? preservationSource;
  if (!source)
    return { ok: false, reason: "The protected source pattern is missing; regenerate from the current project." };
  if (!Number.isSafeInteger(pattern.stepCount) || pattern.stepCount <= 0)
    return { ok: false, reason: "The candidate has an invalid pattern length." };
  try {
    const invariants = inspectPatternInvariants(doc, pattern);
    if (!invariants.ok)
      return { ok: false, reason: `Invalid candidate: ${invariants.issues.map((issue) => issue.code).join(", ")}.` };
  } catch {
    return { ok: false, reason: "The candidate pattern is malformed." };
  }
  if (roles.includes("drums")) {
    const drum = drumTrackForTarget(doc, plan.options.drumTrackId);
    if (!drum) return { ok: false, reason: "Protected drums have no source track." };
    for (const pad of drum.pads) {
      const row = source.rows[pad.id];
      const actual = pattern.rows[pad.id];
      if (row?.slice(pattern.stepCount).some((value) => value !== 0))
        return { ok: false, reason: `Protected ${pad.name} contains hits beyond the candidate length.` };
      const expected = row ? Array.from({ length: pattern.stepCount }, (_, index) => row[index] ?? 0) : undefined;
      if (!deepEqualRef(actual, expected)) return { ok: false, reason: `Protected drum pattern changed: ${pad.name}.` };
      const meta = source.stepMeta?.[pad.id];
      const retained = meta
        ? Object.fromEntries(Object.entries(meta).filter(([step]) => Number(step) < pattern.stepCount))
        : undefined;
      const expectedMeta = retained && Object.keys(retained).length ? retained : undefined;
      if (!deepEqualRef(pattern.stepMeta?.[pad.id], expectedMeta))
        return { ok: false, reason: `Protected drum timing or accents changed: ${pad.name}.` };
    }
  }
  for (const role of roles) {
    if (role === "drums") continue;
    const track = instrumentTrackForRole(doc, role === "chords" ? "chord" : role, plan.options.instrumentTrackIds);
    if (!track) return { ok: false, reason: `Protected ${role} track is missing.` };
    const available = [...(pattern.notes[track.id] ?? [])];
    for (const note of source.notes[track.id] ?? []) {
      if (note.start + note.duration > pattern.stepCount * STEP_TICKS)
        return { ok: false, reason: `Protected ${role} notes extend beyond the candidate.` };
      const index = available.findIndex((candidate) => sameNote(note, candidate));
      if (index < 0) return { ok: false, reason: `Protected ${role} note content changed.` };
      available.splice(index, 1);
    }
  }
  return scope;
}

/** Reuse the same document-delta constraint boundary as mix previews. */
export function checkPatternProposalWrite(
  doc: ProjectDocument,
  next: ProjectDocument,
  result: GenerationResult,
): Result<ProposalConstraints> {
  if (!result.proposal) return { ok: false, reason: "The generation has no candidate." };
  const checked = checkPatternPreservation(doc, result.plan, result.proposal.pattern, result.preservationSource);
  if (!checked.ok) return checked;
  const scope = checkProposalConstraints(doc, next, checked.value);
  if (!scope.ok)
    return {
      ok: false,
      reason:
        scope.reason ?? `Protected project element changed: ${scope.violations.map((item) => item.path).join(", ")}`,
    };
  return checked;
}

/** Capture the checked candidate as project-native evidence, with no inferred listening result. */
export function buildPatternMusicalProposal(
  doc: ProjectDocument,
  result: GenerationResult,
  revision: number | null,
): Result<PatternMusicalProposalV1> {
  if (!result.proposal) return { ok: false, reason: "The generation has no candidate." };
  const checked = checkPatternPreservation(doc, result.plan, result.proposal.pattern, result.preservationSource);
  if (!checked.ok) return checked;
  const sourcePatternId =
    result.plan.preserveSourcePatternId ?? result.plan.intent.sourcePatternId ?? doc.activePatternId;
  if (
    !doc.patterns.some((pattern) => pattern.id === sourcePatternId) &&
    result.preservationSource?.id !== sourcePatternId
  )
    return { ok: false, reason: "Source pattern is missing." };
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0))
    return { ok: false, reason: "Invalid project revision." };
  return {
    ok: true,
    value: {
      schema: "kyx.musical-proposal",
      version: 1,
      kind: "pattern",
      id: `pattern:${result.proposal.pattern.id}`,
      base: { projectId: doc.id, revision, freshness: revision === null ? "unknown" : "current" },
      scope: {
        sourcePatternId,
        audition: null,
        writeScope: "declared",
        targetTrackIds: [
          ...result.plan.rolePlans.drums.targetTrackIds,
          ...result.plan.rolePlans.bass.targetTrackIds,
          ...result.plan.rolePlans.chords.targetTrackIds,
          ...result.plan.rolePlans.lead.targetTrackIds,
        ],
      },
      intent: {
        label: result.plan.intent.text ?? "Pattern generation",
        goals: result.plan.intent.roles.map((role) => `generate:${role}`),
        interpreter: "intent_engine",
        roles: [...result.plan.intent.roles],
        preserve: [...(result.plan.intent.preserve ?? [])],
      },
      executionPlan: structuredClone(result.plan),
      constraints: { status: "declared", rules: checked.value },
      candidates: [{ id: result.proposal.pattern.id, pattern: structuredClone(result.proposal.pattern) }],
      evidence: [
        {
          id: "source-pattern",
          kind: result.preservationSource ? "session_candidate" : "project_fact",
          sourcePatternId,
          ...(result.preservationSource ? { sourcePattern: structuredClone(result.preservationSource) } : {}),
        },
      ],
      checks: { structural: "verified", acoustic: "not_measured", subjective: "not_judged" },
      warnings: [...result.diagnostics.warnings],
    },
  };
}

/** Validate the entire envelope against the current project and the exact candidate. */
export function validatePatternMusicalProposal(
  value: unknown,
  doc: ProjectDocument,
  revision: number | null,
  result: GenerationResult,
): Result<PatternMusicalProposalV1> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, reason: "Missing or invalid pattern proposal contract." };
  const base = (value as { base?: { projectId?: unknown; revision?: unknown } }).base;
  if (base?.projectId !== doc.id) return { ok: false, reason: "The proposal belongs to another project." };
  if (base.revision !== revision)
    return { ok: false, reason: "The proposal is stale; regenerate it for the current project revision." };
  const expected = buildPatternMusicalProposal(doc, result, revision);
  if (!expected.ok) return expected;
  if (!deepEqualRef(value, expected.value))
    return {
      ok: false,
      reason: "The pattern proposal contract, candidate, constraints, or evidence changed or is incomplete.",
    };
  return expected;
}
