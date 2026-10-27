/**
 * clampRepairs — the NORMALISER's footprint, read from the document.
 *
 * Audit F-12 named `normalizeProject` as the authority that silently clamps
 * user intent. The finding's prescription was "have the normaliser collect
 * what it changed and surface it through Command.detail" — and the store is
 * the only place that can do that without teaching the normaliser about
 * toasts:
 *
 * - The store holds the document the command produced (BEFORE normalisation)
 *   and the document the normaliser returned (AFTER it).
 * - The difference between the two IS the normaliser's footprint, and nothing
 *   else — the command's own write is already on the "before" side.
 * - `normalizeProject` returns the SAME object when it changed nothing, so
 *   the whole mechanism costs one reference check per apply; the delta is
 *   computed only when the normaliser actually repaired something.
 *
 * MEASURED (tmp-probe/f12-normalizer-footprint.test.ts, 2026-10-27): a legal
 * effect-parameter write, an out-of-range effect-parameter write (the command
 * clamps it, so the normaliser sees a legal value) and a track creation all
 * leave a footprint of ZERO ops. An out-of-range master-config write leaves
 * exactly the three clamped fields. The footprint reader therefore reports
 * only real repairs — there is no noise on the common path.
 *
 * What it CANNOT report: the authoritative RANGE a value was clamped into.
 * The document carries the values, not the rules, so the range is omitted and
 * the disclosure says what moved instead of what the legal range was.
 */
import { computeDocDelta, type DeltaPath } from "../commands/docDelta";
import { repairClamp, valueClampUnranged, type ClampEvent } from "../shared/clamp-report";
import type { ProjectDocument } from "../project-model/types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "limiterLookaheadMs" → "limiter lookahead ms". */
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

/** "master.limiterLookaheadMs" → "Master · limiter lookahead ms". */
export function humanizePath(path: DeltaPath): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === "string") parts.push(humanizeKey(segment));
    else if (typeof segment === "number") parts.push(`[${segment}]`);
    else parts.push(segment.id);
  }
  const label = parts.join(" · ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Read the value a path pointed at BEFORE the normaliser ran. */
function readPath(root: unknown, path: DeltaPath): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (node == null || typeof node !== "object") return undefined;
    if (typeof segment === "string") {
      if (!isPlainObject(node)) return undefined;
      node = node[segment];
      continue;
    }
    if (typeof segment === "number") {
      if (!Array.isArray(node)) return undefined;
      node = node[segment];
      continue;
    }
    if (!Array.isArray(node)) return undefined;
    node = node.find((item) => isPlainObject(item) && item.id === segment.id);
  }
  return node;
}

/**
 * The normaliser's repairs, as disclosure events. Empty when the normaliser
 * changed nothing — the common case, and the one that must stay silent.
 */
export function normalizerRepairs(before: ProjectDocument, after: ProjectDocument): ClampEvent[] {
  if (before === after) return [];
  const events: ClampEvent[] = [];
  let ops;
  try {
    ops = computeDocDelta(before, after).ops;
  } catch {
    // A diff failure must never break a write — the disclosure is best-effort.
    return events;
  }
  for (const op of ops) {
    const label = humanizePath(op.path);
    const target = op.path
      .map((segment) =>
        typeof segment === "string" ? segment : typeof segment === "number" ? String(segment) : segment.id,
      )
      .join(".");
    if (op.k === "set") {
      const previous = readPath(before, op.path);
      if (typeof previous === "number" && typeof op.value === "number") {
        const event = valueClampUnranged(target, label, previous, op.value);
        if (event) events.push(event);
      } else {
        events.push(repairClamp(target, label, "rewritten by the normaliser"));
      }
      continue;
    }
    if (op.k === "del") {
      events.push(repairClamp(target, label, "removed by the normaliser"));
      continue;
    }
    if (op.k === "ins") {
      events.push(repairClamp(target, label, "added by the normaliser"));
    }
  }
  return events;
}
