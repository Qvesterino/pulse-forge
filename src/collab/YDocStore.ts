/**
 * YDocStore — wraps a Y.Doc and exposes the same public API as ProjectStore.
 *
 * This allows the rest of the codebase (UI, engine, scheduler) to work
 * unchanged — they still call store.getDoc(), store.execute(), store.undo(), etc.
 * Under the hood, mutations go to the Y.Doc which handles CRDT sync.
 */
import * as Y from "yjs";
import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";
import { normalizeProject } from "../project-model/schema";
import { yDocToProject, projectToYDoc, applyProjectToYMap } from "./YDocAdapter";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "syncing";

export interface HistoryEntry {
  label: string;
  type: string;
  timestamp: number;
}

/**
 * YDocStore — CRDT-backed project store.
 *
 * Exposes the same public interface as ProjectStore so the rest of the
 * codebase works without changes. Under the hood, all mutations go to the
 * Y.Doc, which handles:
 * - Conflict-free concurrent edits
 * - Undo/redo scoped to the local user only (remote collaborators' edits
 *   are never tracked, so undoing never roll back someone else's work)
 * - Binary sync over y-websocket
 */
export class YDocStore {
  private yDoc: Y.Doc;
  private yMap: Y.Map<unknown>;
  private listeners = new Set<() => void>();
  private saveStatus_: SaveStatus = "saved";
  private lastSavedAt_: string | null = null;
  private undoManager: Y.UndoManager;
  private pendingLabel: string | null = null;
  /** Label of the item just moved to the opposite stack by undo()/redo(). */
  private lastUndoneLabel: string | null = null;
  private lastCoalesce: { key: string; at: number } | null = null;
  private doc_: ProjectDocument;
  onDocChanged: ((doc: ProjectDocument) => void) | null = null;

  constructor(yDoc: Y.Doc) {
    this.yDoc = yDoc;
    this.yMap = yDoc.getMap("project");
    this.doc_ = this.readDoc(true);
    const undoManager = new Y.UndoManager(this.yMap, { trackedOrigins: new Set([this]) });
    this.undoManager = undoManager;

    // Stash the command label on each undo stack item so the history panel
    // can show real labels. yjs creates a NEW StackItem for the opposite
    // stack on every undo()/redo() (the event `type` names the TARGET stack:
    // 'undo' = pushed to undoStack, 'redo' = pushed to redoStack), so the
    // label is carried across via lastUndoneLabel — otherwise every redo
    // showed up as "Edit" in the history panel.
    undoManager.on("stack-item-added", ({ stackItem, type }) => {
      const label = this.pendingLabel ?? this.lastUndoneLabel ?? "Edit";
      stackItem.meta.set("label", label);
      stackItem.meta.set("timestamp", Date.now());
      stackItem.meta.set("type", "collab");
      void type;
    });

    // Subscribe to Y.Doc changes and re-read the snapshot. LOCAL commands
    // (origin === this, same trust level as the plain ProjectStore) re-project
    // without normalization — full normalization on every keystroke costs
    // ~tens of ms on large documents. REMOTE merges (foreign origin) and
    // undo/redo re-projections are sanitized: a peer or an offline merge can
    // inject state the local code cannot use, e.g. a dangling activePatternId
    // that made getActivePattern() throw on every scheduler tick.
    this.yDoc.on("update", (_update, origin) => {
      this.doc_ = this.readDoc(origin !== this);
      this.emit();
      this.onDocChanged?.(this.doc_);
    });
  }

  /**
   * Project the Y.Doc into a ProjectDocument, optionally through
   * normalizeProject (see the update-listener comment for the trade-off).
   */
  private readDoc(normalize: boolean): ProjectDocument {
    const projected = yDocToProject(this.yMap);
    return normalize ? normalizeProject(projected) : projected;
  }

  /** Initialize from a plain ProjectDocument (used on first open). */
  static fromDocument(doc: ProjectDocument): YDocStore {
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    return new YDocStore(yDoc);
  }

  /** Get the underlying Y.Doc for sync providers. */
  get yDocRef(): Y.Doc {
    return this.yDoc;
  }

  // ─── Public API (matches ProjectStore) ──────────────────────────────

  get doc(): ProjectDocument {
    return this.doc_;
  }

  get canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  get canRedo(): boolean {
    return this.undoManager.canRedo();
  }

  get undoStackLength(): number {
    // Y.UndoManager doesn't expose stack length directly
    return this.canUndo ? 1 : 0;
  }

  get lastCommandLabel(): string | null {
    const top = this.undoManager.undoStack[this.undoManager.undoStack.length - 1];
    return (top?.meta.get("label") as string | undefined) ?? null;
  }

  /** Last N undo entries (for the history panel), matching ProjectStore. */
  get history(): HistoryEntry[] {
    const stack = this.undoManager.undoStack;
    const n = Math.min(stack.length, 20);
    const entries: HistoryEntry[] = [];
    for (let i = stack.length - n; i < stack.length; i++) {
      entries.push({
        label: (stack[i].meta.get("label") as string | undefined) ?? "Edit",
        type: (stack[i].meta.get("type") as string | undefined) ?? "collab",
        timestamp: (stack[i].meta.get("timestamp") as number | undefined) ?? 0,
      });
    }
    return entries;
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

  /** Force re-read of the snapshot from Y.Doc. Call after external sync. */
  refreshSnapshot(): void {
    this.doc_ = this.readDoc(true);
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getDoc = (): ProjectDocument => this.doc_;

  getSaveStatus = (): SaveStatus => this.saveStatus_;

  getLastSavedAt = (): string | null => this.lastSavedAt_;

  /**
   * Execute a command. If the command has applyToYDoc, use it for efficient
   * Y.Doc mutations. Otherwise, apply a targeted diff that updates existing
   * Y.js items in place (critical for correct cross-doc CRDT sync).
   *
   * Transactions run with the UndoManager as origin, so undo tracks local
   * edits only — remote collaborators' changes arrive with a different
   * origin and never enter the local undo stack.
   */
  execute(command: Command): void {
    this.pendingLabel = command.label;
    try {
      // `this` (the store) is the tracked origin — only local commands land
      // in the undo stack; remote updates arrive with foreign origins.
      this.yDoc.transact(() => {
        if (command.applyToYDoc) {
          command.applyToYDoc(this.yMap);
        } else {
          // Fallback: compute new doc and apply targeted diff
          const newDoc = command.execute(this.doc_);
          applyProjectToYMap(this.doc_, newDoc, this.yMap);
        }
      }, this);
    } finally {
      this.pendingLabel = null;
    }
    // One undo step per command (matching ProjectStore), except for
    // continuous gestures marked with a coalesceKey (MIDI CC sweeps) which
    // merge within a short window — the UndoManager merges stack items
    // created inside captureTimeout.
    const now = Date.now();
    const sameGesture =
      command.coalesceKey != null &&
      this.lastCoalesce?.key === command.coalesceKey &&
      now - this.lastCoalesce.at <= 1000;
    if (!sameGesture) this.undoManager.stopCapturing();
    this.lastCoalesce = command.coalesceKey != null ? { key: command.coalesceKey, at: now } : null;
    this.afterMutation();
  }

  undo(): void {
    if (!this.undoManager.canUndo()) return;
    const top = this.undoManager.undoStack[this.undoManager.undoStack.length - 1];
    this.lastUndoneLabel = (top?.meta.get("label") as string | undefined) ?? null;
    this.undoManager.undo();
    this.afterMutation();
  }

  redo(): void {
    if (!this.undoManager.canRedo()) return;
    const top = this.undoManager.redoStack[this.undoManager.redoStack.length - 1];
    this.lastUndoneLabel = (top?.meta.get("label") as string | undefined) ?? null;
    this.undoManager.redo();
    this.afterMutation();
  }

  replaceDoc(doc: ProjectDocument): void {
    const normalized = normalizeProject(doc);
    // Stop tracking, then clear + repopulate in ONE transaction — peers must
    // never observe the intermediate empty-project frame (and record the
    // wipe as two foreign edits).
    this.undoManager.stopCapturing();
    this.yDoc.transact(() => {
      this.yMap.clear();
      projectToYDoc(normalized, this.yMap);
    });
    this.undoManager.clear();
    this.afterMutation();
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private afterMutation(): void {
    this.saveStatus_ = "dirty";
    this.emit();
    this.onDocChanged?.(this.doc_);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
