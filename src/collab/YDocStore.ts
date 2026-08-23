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

/**
 * YDocStore — CRDT-backed project store.
 *
 * Exposes the same public interface as ProjectStore so the rest of the
 * codebase works without changes. Under the hood, all mutations go to
 * the Y.Doc, which handles:
 * - Conflict-free concurrent edits
 * - Undo/redo scoped to local user
 * - Binary sync over y-websocket
 * - Persistence via y-indexeddb
 */
export class YDocStore {
  private yDoc: Y.Doc;
  private yMap: Y.Map<unknown>;
  private listeners = new Set<() => void>();
  private saveStatus_: SaveStatus = "saved";
  private lastSavedAt_: string | null = null;
  private undoManager: Y.UndoManager;
  private doc_: ProjectDocument;
  onDocChanged: ((doc: ProjectDocument) => void) | null = null;

  constructor(yDoc: Y.Doc) {
    this.yDoc = yDoc;
    this.yMap = yDoc.getMap("project");
    this.doc_ = yDocToProject(this.yMap);
    this.undoManager = new Y.UndoManager(this.yMap);

    // Subscribe to Y.Doc changes and re-read the snapshot
    this.yDoc.on("update", () => {
      this.doc_ = yDocToProject(this.yMap);
      this.emit();
      this.onDocChanged?.(this.doc_);
    });
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
    return this.canUndo ? "Last action" : null;
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
    this.doc_ = yDocToProject(this.yMap);
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
   */
  execute(command: Command): void {
    this.yDoc.transact(() => {
      if (command.applyToYDoc) {
        command.applyToYDoc(this.yMap);
      } else {
        // Fallback: compute new doc and apply targeted diff
        const newDoc = command.execute(this.doc_);
        applyProjectToYMap(this.doc_, newDoc, this.yMap);
      }
    });
    this.afterMutation();
  }

  undo(): void {
    if (!this.undoManager.canUndo()) return;
    this.undoManager.undo();
    this.afterMutation();
  }

  redo(): void {
    if (!this.undoManager.canRedo()) return;
    this.undoManager.redo();
    this.afterMutation();
  }

  replaceDoc(doc: ProjectDocument): void {
    const normalized = normalizeProject(doc);
    // Stop tracking, clear all data, re-populate
    this.undoManager.stopCapturing();
    this.yMap.clear();
    projectToYDoc(normalized, this.yMap);
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
