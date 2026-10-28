import { computeDocDelta, type DeltaPath } from "../commands/docDelta";
import type { ProjectDocument } from "../project-model/types";
import { checkCommandScope, verifyScope, type ScopeDeclaration, type ScopeViolation } from "../mcp/scope-guard";

/** A declared empty allow-list permits no writes; an omitted list is unrestricted. */
export interface ProposalConstraints {
  allow?: DeltaPath[];
  protect?: DeltaPath[];
}

const MAX_PATHS = 128;
const MAX_SEGMENTS = 32;

function validPath(value: unknown): value is DeltaPath {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SEGMENTS &&
    value.every((segment: unknown) => {
      if (typeof segment === "string")
        return (
          segment.length > 0 && segment.length <= 128 && !["__proto__", "constructor", "prototype"].includes(segment)
        );
      if (typeof segment === "number") return Number.isSafeInteger(segment) && segment >= 0;
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) return false;
      const record = segment as Record<string, unknown>;
      return (
        Object.keys(record).length === 1 &&
        typeof record.id === "string" &&
        record.id.length > 0 &&
        record.id.length <= 128
      );
    })
  );
}

/** Parse an untrusted constraint declaration without silently dropping malformed rules. */
export function parseProposalConstraints(value: unknown): ProposalConstraints | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "allow" && key !== "protect")) return null;
  for (const key of ["allow", "protect"] as const) {
    const paths = record[key];
    if (paths !== undefined && (!Array.isArray(paths) || paths.length > MAX_PATHS || !paths.every(validPath)))
      return null;
  }
  return structuredClone(record) as ProposalConstraints;
}

/** Check actual candidate changes before any command is dispatched. */
export function checkProposalConstraints(
  base: ProjectDocument,
  candidate: ProjectDocument,
  constraints: ProposalConstraints,
): { ok: boolean; violations: ScopeViolation[]; reason?: string } {
  const parsed = parseProposalConstraints(constraints);
  if (!parsed) return { ok: false, violations: [], reason: "invalid constraint declaration" };
  if (base.id !== candidate.id) return { ok: false, violations: [], reason: "candidate project identity changed" };
  const ops = computeDocDelta(base, candidate).ops;
  if (ops.some((op) => op.path.length === 0))
    return { ok: false, violations: [], reason: "root replacement cannot be scoped" };
  if (parsed.allow?.length === 0 && ops.length > 0)
    return { ok: false, violations: [], reason: "empty allow-list forbids writes" };
  if (ops.length === 0) return { ok: true, violations: [] };
  const scope: ScopeDeclaration = parsed;
  const command = {
    type: "proposal-check",
    label: "proposal-check",
    base,
    ops,
    execute: () => candidate,
    undo: () => base,
  };
  const declared = checkCommandScope(command, scope);
  const verified = verifyScope(base, candidate, ops, scope);
  return {
    ok: declared.length === 0 && verified.verifiable && verified.ok,
    violations: [...declared, ...verified.violations],
  };
}
