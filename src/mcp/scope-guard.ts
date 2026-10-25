/**
 * KYX MCP — SCOPE GUARD (ADR 0065).
 *
 * The permission lattice decides WHETHER a call may proceed. This module
 * decides WHETHER IT STAYED INSIDE ITS DECLARED SCOPE — and it does that on
 * the evidence the command already carries.
 *
 * WHY THIS IS CHEAP
 * -----------------
 * A snapshot/delta command already carries:
 *   - `base`  — the document the write was COMPUTED AGAINST,
 *   - `ops`   — the exact paths the write TOUCHES.
 * So the "declared scope" and the "actual diff" are not reconstructed from a
 * diff engine: they are the command's own words. The guard compares those
 * words against what the caller was allowed to touch, and against the paths
 * the caller said must not change.
 *
 * This is the same trick the stale-write guard (F-25, `write-conflict.ts`)
 * uses, and it composes with it: F-25 answers "did the field I am about to
 * write move under me?", this answers "am I allowed to write it at all, and
 * did I touch anything I promised not to touch?".
 *
 * TWO PHASES, DIFFERENT HONESTY
 * ------------------------------
 *   ENFORCEMENT (this guard) runs BEFORE the write. It refuses a command
 *   whose declared ops would (a) touch a path outside the allowed scope, or
 *   (b) touch a protected path at all. Nothing is written.
 *
 *   VERIFICATION (`verifyScope`) runs AFTER a write and compares base → after.
 *   It can catch a protected path that changed INDIRECTLY — which the
 *   pre-write check cannot see, because it only knows the declared ops.
 *   The verifier is the verifier's job (P-2's next increment); this module
 *   provides the primitive and says plainly when it cannot see.
 *
 * HONEST LIMIT
 * ------------
 * A hand-written command (an `execute`/`undo` pair with no `base`/`ops`)
 * carries no paths, so its scope is NOT VERIFIABLE. The guard says so
 * rather than passing silently — a caller that asked for a scoped write and
 * got an unverifiable one must be able to see that.
 */
import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import type { DeltaOp, DeltaPath, DeltaPathSegment } from "../commands/docDelta";
import { deepEqualRef } from "../commands/docDelta";
import { readPath, describePath } from "./write-conflict";

/**
 * What a caller declared it would do.
 *
 * `allow` — the paths the write may touch. Undefined or empty means
 * UNRESTRICTED (the historical behaviour: a call may touch what it needs).
 * `protect` — the paths that must NOT change. Always honoured, even when
 * `allow` is unrestricted: a promise to protect something is never
 * cancelled by not constraining the rest.
 */
export interface ScopeDeclaration {
  allow?: DeltaPath[];
  protect?: DeltaPath[];
}

export type ScopeViolation =
  /** the write touched a path outside the declared scope */
  | { kind: "out-of-scope"; path: string; allowed: string[] }
  /** the write WOULD have touched a protected path (caught before the write) */
  | { kind: "protected-targeted"; path: string }
  /** a protected path changed (observed after the write) */
  | { kind: "protected-changed"; path: string; before: unknown; after: unknown };

export interface ScopeVerdict {
  /** True when nothing was violated. */
  ok: boolean;
  violations: ScopeViolation[];
  /**
   * False when the command carries no paths — its scope could not be
   * checked. The caller must report this honestly rather than implying the
   * write was verified.
   */
  verifiable: boolean;
}

/** Thrown by the guarded tool context when a write would leave its scope. */
export class ScopeViolationError extends Error {
  constructor(readonly violations: ScopeViolation[]) {
    super(`scoped write refused — ${violations.map((violation) => describeScopeViolation(violation)).join("; ")}`);
    this.name = "ScopeViolationError";
  }
}

function segmentEquals(a: DeltaPathSegment, b: DeltaPathSegment): boolean {
  if (typeof a === "string") return typeof b === "string" && a === b;
  if (typeof a === "number") return typeof b === "number" && a === b;
  if (typeof b === "string" || typeof b === "number") return false;
  return a.id === b.id;
}

/** True when `container` is a prefix of `target` (or equal to it). */
export function pathContains(container: DeltaPath, target: DeltaPath): boolean {
  if (container.length > target.length) return false;
  for (let i = 0; i < container.length; i++) {
    if (!segmentEquals(container[i], target[i])) return false;
  }
  return true;
}

/** True when the path may be written under this declaration. */
export function scopeAllows(scope: ScopeDeclaration | null | undefined, path: DeltaPath): boolean {
  if (scope == null) return true;
  const allow = scope.allow;
  if (allow == null || allow.length === 0) return true;
  return allow.some((container) => pathContains(container, path));
}

/**
 * The violations a command's DECLARED ops would cause, judged before the
 * write happens. A command with no `ops` cannot be judged — the caller must
 * report that honestly rather than implying the write was checked.
 */
export function checkCommandScope(command: Command, scope: ScopeDeclaration): ScopeViolation[] {
  const ops = command.ops ?? [];
  const violations: ScopeViolation[] = [];
  const base = command.base ?? undefined;
  const allowed = (scope.allow ?? []).map((path) => describePath(path, base));

  for (const op of ops) {
    if (op.path.length === 0) continue;
    if (!scopeAllows(scope, op.path)) {
      violations.push({ kind: "out-of-scope", path: describePath(op.path, base), allowed });
    }
    for (const protectedPath of scope.protect ?? []) {
      // Either the op writes inside the protected path, or it replaces the
      // thing the protected path lives in — both would change it.
      if (pathContains(op.path, protectedPath) || pathContains(protectedPath, op.path)) {
        violations.push({ kind: "protected-targeted", path: describePath(protectedPath, base) });
      }
    }
  }
  return violations;
}

/**
 * Wrap the tool context so every write is checked against the declared
 * scope AT THE MOMENT IT LANDS — the same place the stale-write guard
 * lives, because that is the only place where the document the write would
 * land on is known exactly.
 */
export function guardScopedWrites<T extends { execute(command: Command): void }>(
  ctx: T,
  scope: ScopeDeclaration | null,
  force: boolean,
): T {
  if (scope == null) return ctx;
  // A SPREAD, not Object.create: the ctx implementations are object literals
  // and a later spread of THIS object must carry every method.
  const guarded = {
    ...ctx,
    execute: (command: Command) => {
      if (!force) {
        const violations = checkCommandScope(command, scope);
        if (violations.length > 0) throw new ScopeViolationError(violations);
      }
      ctx.execute(command);
    },
  } as T;
  return guarded;
}

/**
 * Verify one command's write against the declared scope AFTER the fact.
 *
 * `base`  — the document the command was computed against,
 * `after` — the document the write produced,
 * `ops`   — the paths the write touched.
 */
export function verifyScope(
  base: ProjectDocument | null | undefined,
  after: ProjectDocument | null | undefined,
  ops: DeltaOp[] | null | undefined,
  scope: ScopeDeclaration | null | undefined,
): ScopeVerdict {
  if (scope == null) return { ok: true, violations: [], verifiable: true };
  if (ops == null || ops.length === 0) {
    // The command carries no paths — there is nothing to compare. Say so.
    return { ok: true, violations: [], verifiable: false };
  }

  const violations: ScopeViolation[] = [];
  const allowed = (scope.allow ?? []).map((path) => describePath(path, base ?? undefined));

  for (const op of ops) {
    if (op.path.length === 0) continue;
    if (!scopeAllows(scope, op.path)) {
      violations.push({ kind: "out-of-scope", path: describePath(op.path, base ?? undefined), allowed });
    }
  }

  const protect = scope.protect ?? [];
  if (protect.length > 0 && base != null && after != null) {
    for (const protectedPath of protect) {
      const before = readPath(base, protectedPath);
      const afterValue = readPath(after, protectedPath);
      if (!deepEqualRef(before, afterValue)) {
        violations.push({
          kind: "protected-changed",
          path: describePath(protectedPath, base),
          before,
          after: afterValue,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations, verifiable: true };
}

/** A readable one-liner for a violation — used in refusals and receipts. */
export function describeScopeViolation(violation: ScopeViolation): string {
  if (violation.kind === "out-of-scope") {
    const allowed = violation.allowed.length > 0 ? violation.allowed.join(", ") : "nothing";
    return `the write touched ${violation.path}, which is outside the declared scope (allowed: ${allowed})`;
  }
  if (violation.kind === "protected-targeted") {
    return `the write would have changed the protected path ${violation.path}`;
  }
  return `the write changed the protected path ${violation.path}`;
}

/**
 * Read a scope declaration out of a tool call envelope.
 *
 * The envelope shape is JSON-friendly: an array of path segments, where a
 * segment is a string, a number, or `{ "id": "..." }`.
 */
export function readScopeDeclaration(envelope: Record<string, unknown>): ScopeDeclaration | null {
  const raw = envelope["scope"];
  if (raw == null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const allow = readPaths(record["allow"]);
  const protect = readPaths(record["protect"]);
  if (allow == null && protect == null) return null;
  return {
    ...(allow != null ? { allow } : {}),
    ...(protect != null ? { protect } : {}),
  };
}

function readPaths(raw: unknown): DeltaPath[] | null {
  if (!Array.isArray(raw)) return null;
  const paths: DeltaPath[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) return null;
    const segments: DeltaPathSegment[] = [];
    for (const segment of entry) {
      if (typeof segment === "string" || typeof segment === "number") {
        segments.push(segment);
      } else if (
        segment != null &&
        typeof segment === "object" &&
        typeof (segment as { id?: unknown }).id === "string"
      ) {
        segments.push({ id: (segment as { id: string }).id });
      } else {
        return null;
      }
    }
    paths.push(segments);
  }
  return paths;
}
