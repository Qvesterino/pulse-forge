import type { ProjectDocument } from "../project-model/types";

export interface Command {
  readonly type: string;
  readonly label: string;
  execute(doc: ProjectDocument): ProjectDocument;
  undo(doc: ProjectDocument): ProjectDocument;
  applyToYDoc?(yMap: any): void;
  undoYDoc?(yMap: any): void;
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
