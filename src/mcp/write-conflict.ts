/**
 * Stale-write detection for the AI's write path (audit F-25).
 *
 * The AI reads the document, decides what to write, and hands the command to
 * the store. Between the READ and the APPLY a human may have changed the very
 * field the AI is about to write — and the delta command applies the AI's
 * value anyway, silently discarding the newer human edit. Measured (probe T2):
 * the human's 0.9 was overwritten by the AI's older 0.5, and the AI's
 * acknowledgement said nothing about it.
 *
 * The document carries no revision counter, so the comparison uses what the
 * command already carries: the document it was computed against (`base`) and
 * the paths it writes (`ops`). A field whose value in the CURRENT document
 * differs from its value in `base` has MOVED — the write is stale.
 *
 * The check is PER FIELD, not per document: a write that touches only the
 * mixer is unaffected by an unrelated edit elsewhere, and an edit to a
 * DIFFERENT track's fader does not block a write to this one.
 */
import type { ProjectDocument } from "../project-model/types";
import type { Command } from "../commands/types";
import { deepEqualRef, type DeltaOp, type DeltaPath } from "../commands/docDelta";

/**
 * Thrown by the guarded tool context when an AI write is STALE (audit F-25).
 * The command is NOT applied — the guard throws before the store sees it.
 */
export class WriteConflictError extends Error {
  constructor(readonly conflict: WriteConflict) {
    super(
      `stale write refused — ${conflict.path} changed from ${formatConflictValue(conflict.expected)} to ${formatConflictValue(conflict.actual)} after this call read the document`,
    );
    this.name = "WriteConflictError";
  }
}

/**
 * Wrap a command so its write is checked for staleness AT THE MOMENT IT
 * LANDS: a field that moved between the tool's read and the apply is
 * refused instead of being overwritten (audit F-25).
 *
 * The check is per field — a write to the mixer is unaffected by an unrelated
 * edit elsewhere, and an edit to another track's fader does not block this
 * one. `force` is the escape hatch for a caller that genuinely means
 * "overwrite regardless"; without it the agent's path is re-read + retry.
 *
 * The guard lives INSIDE the command's execute, not around the store call:
 * that is the only place where the document the write would land on is
 * known exactly. The store's own guard clause (`applied === this.doc_` →
 * no undo entry) is not even reached — the throw happens first, so the
 * refusal leaves no history behind.
 */
export function guardStaleWrite(command: Command, force: boolean): Command {
  if (force) return command;
  const base = command.base;
  const ops = command.ops;
  if (!base || !ops || ops.length === 0) return command;
  return {
    ...command,
    execute: (doc: ProjectDocument) => {
      const conflict = detectWriteConflict(base, doc, ops);
      if (conflict) throw new WriteConflictError(conflict);
      return command.execute(doc);
    },
  };
}

/**
 * Wrap the tool context so EVERY AI write passes the stale-write guard.
 */
export function guardStaleWrites<T extends { execute(command: Command): void }>(ctx: T, force: boolean): T {
  if (force) return ctx;
  // A SPREAD, not Object.create: the ctx implementations are object literals,
  // and a later spread of THIS object must still carry every method. (A
  // prototype-based wrapper loses them to the next spread — which broke the
  // batch's sub-calls.)
  const guarded = { ...ctx, execute: (command: Command) => ctx.execute(guardStaleWrite(command, force)) } as T;
  return guarded;
}

export interface WriteConflict {
  /** Human-readable path, e.g. `tracks["Drums"].gain`. */
  path: string;
  /** The value the AI read — the base its write was computed from. */
  expected: unknown;
  /** The value the field holds NOW. */
  actual: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read one delta path out of a document. */
export function readPath(root: unknown, path: DeltaPath): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (node === null || node === undefined) return undefined;
    if (typeof segment === "string") {
      node = isObject(node) ? node[segment] : undefined;
    } else if (typeof segment === "number") {
      node = Array.isArray(node) ? node[segment] : undefined;
    } else {
      node = Array.isArray(node)
        ? node.find((item) => isObject(item) && item.id === segment.id)
        : undefined;
    }
  }
  return node;
}

/** A short, quotable name for a delta path — entity ids resolve to names. */
export function describePath(path: DeltaPath, root?: unknown): string {
  const parts: string[] = [];
  let node: unknown = root;
  for (const segment of path) {
    if (typeof segment === "string") {
      parts.push(parts.length > 0 ? `.${segment}` : segment);
      node = isObject(node) ? node[segment] : undefined;
    } else if (typeof segment === "number") {
      parts.push(`[${segment}]`);
      node = Array.isArray(node) ? node[segment] : undefined;
    } else {
      const found = Array.isArray(node) ? node.find((item) => isObject(item) && item.id === segment.id) : undefined;
      const name = found && typeof found.name === "string" ? found.name : segment.id;
      parts.push(`["${name}"]`);
      node = found;
    }
  }
  return parts.join("");
}

/**
 * The first stale field among the paths this command writes, or null.
 *
 * `base` is the document the command was computed against; `current` is the
 * document the write would land on. A path whose value differs between them
 * MOVED — the write would overwrite someone else's newer value.
 */
export function detectWriteConflict(
  base: ProjectDocument,
  current: ProjectDocument,
  ops: DeltaOp[],
): WriteConflict | null {
  for (const op of ops) {
    if (op.path.length === 0) continue;
    const expected = readPath(base, op.path);
    const actual = readPath(current, op.path);
    if (!deepEqualRef(expected, actual)) {
      return { path: describePath(op.path, base), expected, actual };
    }
  }
  return null;
}

/** A readable value for the conflict message. */
export function formatConflictValue(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : String(value);
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}
