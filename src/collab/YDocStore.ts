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
import { registerYDocHelpers } from "../commands/yDocBridge";
import { roleAllows, type JamRole } from "./jamRoles";
import {
  ySetPatternField,
  ySetProjectField,
  ySetStepVelocity,
  ySetTrackField,
  yToggleStep,
} from "../commands/yDocHelpers";

// The command factories in commands.ts stay yjs-free (yjs ships only in this
// collab chunk) — they reach the helpers through the bridge, registered here
// where yjs is guaranteed to be loaded anyway.
registerYDocHelpers({
  yToggleStep: (yMap, patternId, padId, stepIndex, defaultVelocity) =>
    yToggleStep(yMap as Y.Map<unknown>, patternId, padId, stepIndex, defaultVelocity),
  ySetStepVelocity: (yMap, patternId, padId, stepIndex, velocity) =>
    ySetStepVelocity(yMap as Y.Map<unknown>, patternId, padId, stepIndex, velocity),
  ySetPatternField: (yMap, patternId, field, value) =>
    ySetPatternField(yMap as Y.Map<unknown>, patternId, field, value),
  ySetTrackField: (yMap, trackId, field, value) => ySetTrackField(yMap as Y.Map<unknown>, trackId, field, value),
  ySetProjectField: (yMap, field, value) => ySetProjectField(yMap as Y.Map<unknown>, field, value),
  createYMap: () => new Y.Map(),
});

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
  /**
   * Jam-role gate: returns the local role (or null = ungated). Wired by
   * openProject to the CollabSession — see jamRoles.ts.
   */
  roleProvider: (() => JamRole | null) | null = null;
  /** Called when the gate refuses a command (UI surfaces the refusal). */
  onRoleBlocked: ((commandType: string, role: JamRole) => void) | null = null;
  /** Last refused command, for the UI — cleared on the next allowed execute. */
  lastRoleBlock: { type: string; role: JamRole; at: number } | null = null;

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
    // without normalization — on large documents the Y.Doc→plain projection
    // (not normalizeProject itself, which is ~2 ms even on huge docs) makes
    // every-keystroke re-reads worth skipping where trust allows. REMOTE
    // merges (foreign origin) and undo/redo re-projections are sanitized:
    // a peer or an offline merge can inject state the local code cannot use,
    // e.g. a dangling activePatternId that made getActivePattern() throw on
    // every scheduler tick.
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

  /**
   * Start with an EMPTY room and a local fallback document. The room is
   * seeded later via hydrate() ONLY when first sync shows no remote content
   * (deferred seeding) — a joiner opening an existing room adopts it through
   * adoptRemote() instead of clobbering it with their own initial doc
   * (Instant Jam: everyone opens the same ?import= code, but a late joiner
   * must never wipe edits made before they arrived).
   */
  static empty(fallback: ProjectDocument): YDocStore {
    const store = new YDocStore(new Y.Doc());
    store.doc_ = fallback;
    return store;
  }

  /** Seed the (empty) room: write the initial document into the Y map. */
  hydrate(doc: ProjectDocument): void {
    this.yDoc.transact(() => projectToYDoc(doc, this.yMap));
  }

  /** Re-read the local document from the (remote-populated) Y map. */
  adoptRemote(): void {
    this.doc_ = this.readDoc(true);
    this.emit();
    this.onDocChanged?.(this.doc_);
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
    // Real stack length — CommandToast dedupes on value changes and the
    // history panel uses it as its change key; a stubbed 0/1 froze both
    // after the first command in collab sessions.
    return this.undoManager.undoStack.length;
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

  // ─── Fine-grained selectors ──────────────────────────────────────────────
  // Mirror of ProjectStore.getScenes/getTracks/... — required so that the
  // `ProjectStore | YDocStore` union in src/ui/context.ts exposes these
  // methods and `useScenes()` / `useTracks()` / etc. compile cleanly in both
  // solo and collab mode. YDocStore delegates to `this.doc_` — the Y.Doc
  // snapshot is read on every call and the slice returned is whatever the
  // Yjs→ProjectDocument projection produced at the time of the last
  // local mutation. For collab, structural sharing is NOT guaranteed at
  // the Yjs level (a remote peer can mutate any slice), so a slice
  // change from anywhere will invalidate every selector — but a local
  // command that mutates only one slice (e.g. a track gain via
  // applyProjectToYMap with targeted diff) leaves the others referentially
  // stable, which is the common case in the UI hot path.
  getScenes = (): ProjectDocument["scenes"] => this.doc_.scenes;
  getTracks = (): ProjectDocument["tracks"] => this.doc_.tracks;
  getReturns = (): ProjectDocument["returns"] => this.doc_.returns;
  getArrangement = (): ProjectDocument["arrangement"] => this.doc_.arrangement;
  getMarkers = (): ProjectDocument["markers"] => this.doc_.markers;
  getAutomation = (): ProjectDocument["automation"] => this.doc_.automation;
  getPatterns = (): ProjectDocument["patterns"] => this.doc_.patterns;
  getMacros = (): ProjectDocument["macros"] => this.doc_.macros;
  getMaster = (): ProjectDocument["master"] => this.doc_.master;
  getSceneAutomation = (): ProjectDocument["sceneAutomation"] => this.doc_.sceneAutomation;
  getActivePatternId = (): ProjectDocument["activePatternId"] => this.doc_.activePatternId;

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
    // Jam-role gate: a restricted role may not run commands outside its
    // bucket. The refusal is surfaced, never thrown — the UI keeps working.
    const role = this.roleProvider?.() ?? null;
    if (role && !roleAllows(role, command.type)) {
      this.lastRoleBlock = { type: command.type, role, at: Date.now() };
      this.onRoleBlocked?.(command.type, role);
      this.emit();
      return;
    }
    this.lastRoleBlock = null;
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

  /**
   * Record frame seam for live MIDI takes. yjs UndoManager groups changes by
   * capture timeout — these calls seal the open undo item before and after a
   * recorded pass, so the take stays one coherent block (best effort: a take
   * longer than the capture timeout still splits inside).
   */
  beginUndoFrame(_label?: string): void {
    this.undoManager.stopCapturing();
  }

  endUndoFrame(): void {
    this.undoManager.stopCapturing();
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

  /**
   * Cubase-style history jump — same contract as ProjectStore.jumpTo:
   * undo/redo until the state after entry `index` (0-based in the undo
   * stack) is current. Without this the history panel's jump silently
   * no-oped in collab sessions.
   */
  jumpTo(index: number): void {
    while (this.undoManager.undoStack.length > index + 1 && this.canUndo) this.undo();
    while (this.undoManager.undoStack.length <= index && this.canRedo) this.redo();
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
    // Defect 4.2 parity (undo/redo integrity audit): after a replace the
    // in-memory doc no longer matches whatever was persisted last — the
    // "SAVED hh:mm" watermark from the previous store must not survive.
    this.lastSavedAt_ = null;
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
