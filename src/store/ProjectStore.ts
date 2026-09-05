import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { normalizeProject } from "../project-model/schema";
import { computeDocDelta } from "../commands/docDelta";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export interface HistoryEntry {
  label: string;
  type: string;
  timestamp: number;
  /** Cheap change summary derived from the command's doc delta (Cubase-style diff). */
  diff?: HistoryDiff;
}

export interface HistoryDiff {
  added: number;
  removed: number;
  changed: number;
}

/** Window in which same-key commands merge into one undo entry. */
const COALESCE_WINDOW_MS = 1000;

export class ProjectStore {
  private doc_: ProjectDocument;
  private listeners = new Set<() => void>();
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private timestamps: number[] = [];
  /** Pre-computed doc snapshots (references, cheap) for history diff + jump. */
  private historyDocs: ProjectDocument[] = [];
  private saveStatus_: SaveStatus = "saved";
  private lastSavedAt_: string | null = null;
  onDocChanged: ((doc: ProjectDocument) => void) | null = null;

  private static readonly HISTORY_LIMIT = 64;

  constructor(initial: ProjectDocument) {
    this.doc_ = initial;
    this.historyDocs.push(initial);
  }

  get doc(): ProjectDocument {
    return this.doc_;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Number of commands currently on the undo stack (used by the toast). */
  get undoStackLength(): number {
    return this.undoStack.length;
  }

  get lastCommandLabel(): string | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  /** Last N history entries (most recent last). For the undo history panel. */
  get history(): HistoryEntry[] {
    const n = Math.min(this.undoStack.length, 20);
    const start = this.undoStack.length - n;
    const entries: HistoryEntry[] = [];
    for (let i = start; i < this.undoStack.length; i++) {
      entries.push({
        label: this.undoStack[i].label,
        type: this.undoStack[i].type,
        timestamp: this.timestamps[i] ?? 0,
        diff: this.diffForIndex(i),
      });
    }
    return entries;
  }

  /**
   * Cheap diff summary for a history entry: ops counts from the doc delta
   * between the entry's before/after snapshot (references, no deep copy).
   * `historyDocs` only tracks the most recent HISTORY_LIMIT snapshots, so an
   * index may fall outside the tracked window once the undo stack grows —
   * those entries report no diff instead of pairing wrong snapshots.
   */
  private diffForIndex(cmdIndex: number): HistoryDiff | undefined {
    const offset = this.undoStack.length + 1 - this.historyDocs.length;
    const docBefore = this.historyDocs[cmdIndex - offset];
    const docAfter = this.historyDocs[cmdIndex - offset + 1];
    if (!docBefore || !docAfter) return undefined;
    try {
      const { ops } = computeDocDelta(docBefore, docAfter);
      let added = 0;
      let removed = 0;
      let changed = 0;
      for (const op of ops) {
        if (op.k === "ins") added += 1;
        else if (op.k === "del") removed += 1;
        else if (op.k === "set") changed += 1;
      }
      return { added, removed, changed };
    } catch {
      return undefined;
    }
  }

  get saveStatus(): SaveStatus {
    return this.saveStatus_;
  }

  get lastSavedAt(): string | null {
    return this.lastSavedAt_;
  }

  setSaveStatus(status: SaveStatus): void {
    this.saveStatus_ = status;
    if (status === "saved") this.lastSavedAt_ = new Date().toISOString();
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getDoc = (): ProjectDocument => this.doc_;

  getSaveStatus = (): SaveStatus => this.saveStatus_;

  getLastSavedAt = (): string | null => this.lastSavedAt_;

  execute(command: Command): void {
    const topIdx = this.undoStack.length - 1;
    const top = this.undoStack[topIdx];
    if (
      command.coalesceKey != null &&
      top?.coalesceKey === command.coalesceKey &&
      Date.now() - (this.timestamps[topIdx] ?? 0) <= COALESCE_WINDOW_MS
    ) {
      // Continuous gesture (e.g. a MIDI CC sweep): collapse into the top
      // entry — redo lands on the newest state, undo returns to the state
      // before the whole gesture began.
      const merged: Command = { ...command, undo: (doc) => top.undo(doc) };
      this.doc_ = merged.execute(this.doc_);
      this.undoStack[topIdx] = merged;
      this.timestamps[topIdx] = Date.now();
      this.redoStack = [];
      this.recordHistoryDoc(this.doc_);
      this.afterMutation();
      return;
    }
    this.doc_ = command.execute(this.doc_);
    this.undoStack.push(command);
    this.timestamps.push(Date.now());
    this.recordHistoryDoc(this.doc_);
    if (this.undoStack.length > 256) {
      this.undoStack.shift();
      this.timestamps.shift();
      this.pruneHistoryDocs();
    }
    this.redoStack = [];
    this.afterMutation();
  }

  undo(): void {
    const command = this.undoStack.pop();
    this.timestamps.pop();
    if (!command) return;
    this.doc_ = command.undo(this.doc_);
    this.redoStack.push(command);
    this.historyDocs.length = Math.min(this.historyDocs.length, this.undoStack.length + 1);
    this.historyDocs[this.historyDocs.length - 1] = this.doc_;
    this.afterMutation();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.doc_ = command.execute(this.doc_);
    this.undoStack.push(command);
    this.timestamps.push(Date.now());
    this.recordHistoryDoc(this.doc_);
    this.afterMutation();
  }

  /**
   * Cubase-style history jump: undo/redo to the state after entry `index`
   * (0-based in the undo stack). One logical entry — no partial application.
   */
  jumpTo(index: number): void {
    while (this.undoStack.length > index + 1) this.undo();
    while (this.undoStack.length <= index && this.redoStack.length > 0) this.redo();
  }

  private recordHistoryDoc(doc: ProjectDocument): void {
    this.historyDocs.push(doc);
    if (this.historyDocs.length > ProjectStore.HISTORY_LIMIT) {
      // Keep the snapshot aligned with the pruned undo stack.
      this.historyDocs.shift();
    }
  }

  private pruneHistoryDocs(): void {
    // The undo stack lost its oldest entry; drop the matching head snapshot.
    // Never pad: historyDocs deliberately tracks fewer snapshots than the
    // stack (HISTORY_LIMIT) — padding with duplicates would balloon memory
    // and pair diffForIndex with fake before/after states.
    while (this.historyDocs.length > this.undoStack.length + 1) this.historyDocs.shift();
  }

  replaceDoc(doc: ProjectDocument): void {
    this.doc_ = normalizeProject(doc);
    this.undoStack = [];
    this.redoStack = [];
    this.historyDocs = [this.doc_];
    // Defect 4.2 (undo/redo integrity audit): afterMutation() sets the
    // save status to "dirty" (correct — the in-memory doc is now
    // different from whatever was last persisted), but it does NOT
    // touch lastSavedAt_. The UI keeps showing "SAVED hh:mm" stamped
    // with the timestamp of the *previous* save, even though the
    // current doc no longer matches that snapshot. Reset the watermark
    // so the indicator reflects "we have no durable copy of this doc".
    this.lastSavedAt_ = null;
    this.afterMutation();
  }

  private afterMutation(): void {
    this.saveStatus_ = "dirty";
    this.emit();
    this.onDocChanged?.(this.doc_);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
