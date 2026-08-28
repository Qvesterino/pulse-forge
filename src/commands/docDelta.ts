/**
 * docDelta — id-anchored structural deltas between immutably-built documents.
 *
 * `snapshot()`-style commands used to pin BOTH whole documents (`execute:
 * () => next, undo: () => prev`). That made every dispatch a wholesale
 * replacement: an async dispatch (e.g. the freeze render) silently reverted
 * anything that changed between command creation and execution, and the undo
 * stack kept whole document chains alive.
 *
 * Instead, the delta describes the CHANGE as a list of operations anchored by
 * object keys and entity ids:
 *   - scalar writes  (`set`)  — applied only where the value actually differs
 *   - removals       (`del`)  — key / id / index, removed subtree captured
 *   - insertions     (`ins`)  — index + captured subtree
 *   - entity moves   (`move`) — id + target index
 *
 * Because commands build `next` immutably (structural sharing), computing the
 * delta prunes identical subtrees by REFERENCE equality — the walk costs
 * O(changes), not O(document).
 *
 * Application is functional (copy-on-write) and tolerant: operations whose
 * anchor is missing (entity deleted mid-flight) are skipped instead of
 * throwing — undo then applies cleanly to whatever document exists now.
 */
import type { ProjectDocument } from "../project-model/types";

/** Path segment: object key, array index (plain arrays) or entity id. */
export type DeltaPathSegment = string | number | { id: string };
export type DeltaPath = DeltaPathSegment[];

export type DeltaOp =
  | { k: "set"; path: DeltaPath; value: unknown }
  | { k: "del"; path: DeltaPath; removed: unknown }
  | { k: "ins"; path: DeltaPath; index: number; value: unknown }
  | { k: "move"; path: DeltaPath; id: string; toIndex: number };

export interface DocDelta {
  ops: DeltaOp[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(item: unknown): string | undefined {
  if (isPlainObject(item) && typeof item.id === "string") return item.id;
  return undefined;
}

/** True when every item is an entity with a string id (id-alignable list). */
function isEntityList(list: unknown[]): boolean {
  return list.length > 0 && list.every((item) => idOf(item) !== undefined);
}

/** Reference-pruned, order-insensitive structural equality. */
export function deepEqualRef(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualRef(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqualRef(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Recursively freeze an object graph. The delta undo engine's correctness
 * rests on the immutability contract: commands build `next` copy-on-write and
 * NEVER mutate `prev`. In DEV/test, snapshot() deep-freezes `prev` so any
 * violation becomes a loud TypeError at the violating write instead of a
 * silently corrupt undo stack. Never call in production paths — freezing the
 * whole document graph costs O(doc) and freezes shared subtrees.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ─── Delta computation ──────────────────────────────────────────────────────

export function computeDocDelta(before: ProjectDocument, after: ProjectDocument): DocDelta {
  const ops: DeltaOp[] = [];
  diffAny(before, after, [], ops);
  return { ops };
}

function diffAny(a: unknown, b: unknown, path: DeltaPath, ops: DeltaOp[]): void {
  if (a === b) return; // structural sharing — unchanged subtree
  if (isPlainObject(a) && isPlainObject(b)) {
    diffObject(a, b, path, ops);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (isEntityList(a) && isEntityList(b)) {
      diffEntityArray(a, b, path, ops);
      return;
    }
    diffPlainArray(a, b, path, ops);
    return;
  }
  ops.push({ k: "set", path, value: b });
}

function diffObject(a: Record<string, unknown>, b: Record<string, unknown>, path: DeltaPath, ops: DeltaOp[]): void {
  for (const key of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      ops.push({ k: "del", path: [...path, key], removed: a[key] });
    }
  }
  for (const key of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) {
      ops.push({ k: "set", path: [...path, key], value: b[key] });
      continue;
    }
    diffAny(a[key], b[key], [...path, key], ops);
  }
}

/** Lists whose items carry unique string ids (tracks, patterns, effects…). */
function diffEntityArray(a: unknown[], b: unknown[], path: DeltaPath, ops: DeltaOp[]): void {
  const aIds = new Map<string, unknown>();
  for (const item of a) aIds.set(idOf(item) as string, item);
  const bIds = new Map<string, unknown>();
  for (const item of b) bIds.set(idOf(item) as string, item);

  // 1. Content changes of surviving entities — id-anchored, order-agnostic.
  for (const [id, bItem] of bIds) {
    if (aIds.has(id)) diffAny(aIds.get(id), bItem, [...path, { id }], ops);
  }
  // 2. Removals (descending not needed — ids anchor the item).
  for (const item of a) {
    const id = idOf(item) as string;
    if (!bIds.has(id)) ops.push({ k: "del", path: [...path, { id }], removed: item });
  }
  // 3. Structural replay of b's order: simulate a (kept items only), then
  //    insert additions and move misplaced items — one op per step.
  const sim: { id: string; value: unknown }[] = a
    .map((item) => ({ id: idOf(item) as string, value: item }))
    .filter((entry) => bIds.has(entry.id));
  for (let i = 0; i < b.length; i++) {
    const item = b[i];
    const id = idOf(item) as string;
    const current = sim.findIndex((entry) => entry.id === id);
    if (current === -1) {
      ops.push({ k: "ins", path, index: i, value: item });
      sim.splice(Math.min(i, sim.length), 0, { id, value: item });
      continue;
    }
    if (current !== i) {
      ops.push({ k: "move", path, id, toIndex: i });
      const [moved] = sim.splice(current, 1);
      sim.splice(Math.min(i, sim.length), 0, moved);
    }
  }
}

/** Lists of primitives or plain objects without ids (rows, points, tags…). */
function diffPlainArray(a: unknown[], b: unknown[], path: DeltaPath, ops: DeltaOp[]): void {
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    diffAny(a[i], b[i], [...path, i], ops);
  }
  // Truncation — descending so index splices stay valid at apply time.
  for (let i = a.length - 1; i >= b.length; i--) {
    ops.push({ k: "del", path: [...path, i], removed: a[i] });
  }
  // Appenditions — ascending.
  for (let i = common; i < b.length; i++) {
    ops.push({ k: "ins", path, index: i, value: b[i] });
  }
}

// ─── Delta application ──────────────────────────────────────────────────────

/**
 * Apply operations to `doc` functionally. Unchanged branches keep their
 * references; anchors that no longer exist are skipped. Returns `doc` itself
 * when nothing applied.
 */
export function applyDocDelta(doc: ProjectDocument, ops: DeltaOp[]): ProjectDocument {
  let result: ProjectDocument = doc;
  for (const op of ops) {
    result = applyOp(result, op) as ProjectDocument;
  }
  return result;
}

function applyOp(node: unknown, op: DeltaOp): unknown {
  if (op.path.length === 0) {
    // The op targets the document root itself — only `set` is meaningful.
    if (op.k === "set") return op.value;
    return node;
  }
  return descend(node, op, 0);
}

function descend(node: unknown, op: DeltaOp, depth: number): unknown {
  if (depth >= op.path.length) return node;
  const segment = op.path[depth];
  const last = depth === op.path.length - 1;

  if (typeof segment === "string") {
    if (!isPlainObject(node)) return node;
    if (last) {
      const child = node[segment];
      // ins/move anchor the ARRAY itself (index/id ride on the op).
      if (op.k === "ins" && Array.isArray(child)) {
        const copy = [...child];
        copy.splice(Math.min(op.index, copy.length), 0, op.value);
        return { ...node, [segment]: copy };
      }
      if (op.k === "move" && Array.isArray(child)) {
        const moved = moveById(child, op.id, op.toIndex);
        return moved === child ? node : { ...node, [segment]: moved };
      }
      return applyLeaf(node, segment, op);
    }
    const child = node[segment];
    const nextChild = descend(child, op, depth + 1);
    if (nextChild === child) return node;
    return { ...node, [segment]: nextChild };
  }

  if (typeof segment === "number") {
    if (!Array.isArray(node)) return node;
    if (last) {
      if (op.k === "ins") {
        const copy = [...node];
        copy.splice(Math.min(segment, copy.length), 0, op.value);
        return copy;
      }
      if (op.k === "del" && segment < node.length) {
        const copy = [...node];
        copy.splice(segment, 1);
        return copy;
      }
      if (op.k === "set" && segment < node.length) {
        const copy = [...node];
        copy[segment] = op.value;
        return copy;
      }
      return node;
    }
    if (segment >= node.length) return node;
    const nextChild = descend(node[segment], op, depth + 1);
    if (nextChild === node[segment]) return node;
    const copy = [...node];
    copy[segment] = nextChild;
    return copy;
  }

  // { id } — entity item inside an id-keyed array.
  const index = Array.isArray(node) ? node.findIndex((item) => idOf(item) === segment.id) : -1;
  if (index === -1 || !Array.isArray(node)) return node;
  if (last) {
    if (op.k === "del") {
      const copy = [...node];
      copy.splice(index, 1);
      return copy;
    }
    if (op.k === "ins") {
      const copy = [...node];
      copy.splice(Math.min(op.index, copy.length), 0, op.value);
      return copy;
    }
    if (op.k === "move") {
      return moveById(node, op.id, op.toIndex);
    }
    // set on an entity item — replace wholesale
    const copy = [...node];
    copy[index] = op.value;
    return copy;
  }
  const nextChild = descend(node[index], op, depth + 1);
  if (nextChild === node[index]) return node;
  const copy = [...node];
  copy[index] = nextChild;
  return copy;
}

function applyLeaf(
  container: Record<string, unknown>,
  key: string,
  op: DeltaOp,
): unknown {
  if (op.k === "set") {
    if (deepEqualRef(container[key], op.value)) return container;
    return { ...container, [key]: op.value };
  }
  if (op.k === "del") {
    if (!Object.prototype.hasOwnProperty.call(container, key)) return container;
    const copy = { ...container };
    delete copy[key];
    return copy;
  }
  return container;
}

function moveById(list: unknown[], id: string, toIndex: number): unknown[] {
  const from = list.findIndex((item) => idOf(item) === id);
  if (from === -1 || from === toIndex) return list;
  const copy = [...list];
  const [moved] = copy.splice(from, 1);
  copy.splice(Math.max(0, Math.min(toIndex, copy.length)), 0, moved);
  return copy;
}
