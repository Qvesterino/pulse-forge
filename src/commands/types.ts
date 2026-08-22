import type { ProjectDocument } from "../project-model/types";

export interface Command {
  readonly type: string;
  readonly label: string;
  execute(doc: ProjectDocument): ProjectDocument;
  undo(doc: ProjectDocument): ProjectDocument;
  applyToYDoc?(yMap: any): void;
  undoYDoc?(yMap: any): void;
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
