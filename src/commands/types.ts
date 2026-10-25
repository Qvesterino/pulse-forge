import type { ProjectDocument } from "../project-model/types";
import type { DeltaOp } from "./docDelta";

export interface Command {
  readonly type: string;
  readonly label: string;
  /**
   * Optional consequence note shown by the command toast under the label —
   * for silent cleanups the command performs beyond what the user asked
   * ("Removed effect — 3 automation/modulation references cleaned up").
   * Undefined when the command did exactly what its label says.
   */
  readonly detail?: string;
  execute(doc: ProjectDocument): ProjectDocument;
  undo(doc: ProjectDocument): ProjectDocument;
  /**
   * The document this command was computed against — the BASE of its write.
   * Snapshot commands carry it; a command that does not (a hand-written
   * execute/undo pair) has no base and is never treated as stale.
   *
   * The AI's write path compares it against the current document to detect a
   * STALE write: a field that moved between the read and the apply would
   * otherwise be overwritten silently, discarding the newer human edit
   * (audit F-25).
   */
  readonly base?: ProjectDocument;
  /**
   * The forward delta's operations — the paths this command writes. Paired
   * with `base` it tells the stale-write check WHICH fields to compare.
   */
  readonly ops?: DeltaOp[];
  /**
   * Direct Y.Doc mutation for collab mode — an efficient targeted path used
   * by YDocStore.execute instead of the generic whole-document diff. Undo in
   * collab does NOT use a counterpart: Y.UndoManager captures inverse
   * operations from the applyToYDoc transaction automatically.
   */
  applyToYDoc?(yMap: any): void;
  /**
   * Continuous-gesture grouping key (e.g. `midi:macro:<id>`). Successive
   * commands with the same key executed within a short time window collapse
   * into ONE undo entry: redo lands on the newest state, undo returns to
   * the state before the gesture began. Used by high-frequency streams like
   * MIDI CC sweeps, which would otherwise flood the capped undo stack and
   * evict real edits.
   */
  readonly coalesceKey?: string;
}

/**
 * Human-edit dispatch for local taste learning. The fallback keeps lightweight
 * host/test adapters compatible while full stores expose the learning signal.
 */
export function executeUserEdit(
  store: { execute(command: Command): void; executeUserEdit?: (command: Command) => void },
  command: Command,
): void {
  if (store.executeUserEdit) store.executeUserEdit(command);
  else store.execute(command);
}

export function ySet(yMap: any, key: string, value: unknown): void {
  yMap.set(key, value);
}

export function yGetOrCreateArray(yMap: any, key: string): any {
  let arr = yMap.get(key);
  if (!arr) {
    arr = new Map();
    yMap.set(key, arr);
  }
  return arr;
}

export function yGetOrCreateMap(yMap: any, key: string): any {
  let m = yMap.get(key);
  if (!m) {
    m = new Map();
    yMap.set(key, m);
  }
  return m;
}
