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
  /** Open undo frame (MIDI record pass) — commands collected live. */
  private frameCommands: Command[] | null = null;
  private frameLabel = "Recorded take";
  /** undoStack.length when the frame opened — pops exactly the frame's entries. */
  private frameOpenDepth = 0;
  /** Pre-computed doc snapshots (references, cheap) for history diff + jump. */
  private historyDocs: ProjectDocument[] = [];
  /**
   * Memo of `diffForIndex(cmdIndex)` results. The history panel
   * calls `diffForIndex` once per visible row on every render, and
   * the underlying `computeDocDelta` walks both snapshots — for a
   * project with hundreds of tracks / patterns this can dominate
   * the panel's render cost. The cache is cleared on every mutation
   * (execute / undo / redo / replaceDoc) so results are always
   * consistent with the current undo stack.
   */
  private diffCache = new Map<number, HistoryDiff | undefined>();
  private saveStatus_: SaveStatus = "saved";
  private lastSavedAt_: string | null = null;
  onDocChanged: ((doc: ProjectDocument) => void) | null = null;

  private static readonly HISTORY_LIMIT = 64;

  constructor(initial: ProjectDocument) {
    // ProjectStore is the plain-document authority. Imports, tests and
    // future callers can bypass replaceDoc(), so enforce the same canonical
    // active-pattern invariant at construction time as we do at replacement.
    this.doc_ = normalizeProject(initial);
    this.historyDocs.push(this.doc_);
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
    // Performance: the history panel calls this for every visible
    // row on every render, and `computeDocDelta` walks the full
    // before/after snapshots. The cmdIndex is stable across renders
    // as long as the undo stack does not mutate, so a tiny Map cache
    // turns an O(rows × project) per-render cost into O(visible rows)
    // per render after the first.
    if (this.diffCache.has(cmdIndex)) return this.diffCache.get(cmdIndex);
    const offset = this.undoStack.length + 1 - this.historyDocs.length;
    const docBefore = this.historyDocs[cmdIndex - offset];
    const docAfter = this.historyDocs[cmdIndex - offset + 1];
    if (!docBefore || !docAfter) {
      this.diffCache.set(cmdIndex, undefined);
      return undefined;
    }
    let result: HistoryDiff | undefined;
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
      result = { added, removed, changed };
    } catch {
      result = undefined;
    }
    this.diffCache.set(cmdIndex, result);
    return result;
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

  // ─── Fine-grained selectors ──────────────────────────────────────────────
  // Each of these returns the corresponding slice of the document. They
  // are stable references for a given snapshot — `normalizeProject` uses
  // structural sharing, so when the user edits a *different* slice (e.g.
  // a track gain) the scenes/tracks/etc. arrays remain the same array
  // identity. Combined with `useSyncExternalStore` in `src/ui/context.ts`
  // this lets a component subscribe to just the slice it actually reads
  // and skip re-renders when only unrelated parts of the document change.
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

  getSaveStatus = (): SaveStatus => this.saveStatus_;

  getLastSavedAt = (): string | null => this.lastSavedAt_;

  execute(command: Command): void {
    const inFrame = this.frameCommands !== null;
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
      this.doc_ = normalizeProject(merged.execute(this.doc_));
      this.undoStack[topIdx] = merged;
      this.timestamps[topIdx] = Date.now();
      this.redoStack = [];
      // History shape changed: any cached `diffForIndex` results are
      // now stale (different before/after snapshot pairs).
      this.diffCache.clear();
      // A coalesced command is one logical gesture. Keep the original
      // before-snapshot and replace only the after-snapshot; appending here
      // creates a micro-step snapshot that makes the history diff pair the
      // wrong states.
      this.historyDocs[this.historyDocs.length - 1] = this.doc_;
      if (inFrame) this.frameCommands!.push(command);
      this.afterMutation();
      return;
    }
    const applied = command.execute(this.doc_);
    if (applied === this.doc_) {
      // Guard-clause no-op (same-index reorder, ungrouped removeFromGroup,
      // race-guarded note moves…): nothing changed — no undo entry, no dirty
      // flag, no engine resync. Dead Ctrl+Z steps were the symptom.
      if (inFrame) this.frameCommands!.push(command);
      return;
    }
    this.doc_ = normalizeProject(applied);
    this.undoStack.push(command);
    this.timestamps.push(Date.now());
    this.diffCache.clear();
    this.recordHistoryDoc(this.doc_);
    if (this.undoStack.length > 256) {
      this.undoStack.shift();
      this.timestamps.shift();
      this.pruneHistoryDocs();
    }
    this.redoStack = [];
    if (inFrame) this.frameCommands!.push(command);
    this.afterMutation();
  }

  /**
   * Undo frame: collapse a multi-command live pass (MIDI record take) into
   * ONE history entry. While a frame is open every execute() still applies
   * live (the pattern updates as you play); endUndoFrame() swaps the frame's
   * per-command undo entries for a single compound command, so one Ctrl+Z
   * removes the whole take. Nested begin calls keep the open frame; an empty
   * frame (nothing recorded) leaves no history entry at all.
   */
  beginUndoFrame(label?: string): void {
    if (this.frameCommands) return;
    this.frameCommands = [];
    this.frameLabel = label ?? "Recorded take";
    this.frameOpenDepth = this.undoStack.length;
    if (this.redoStack.length > 0) {
      this.redoStack = [];
      // canRedo flipped false — notify so the Redo button does not stay
      // enabled on a stale view (clicking it was a harmless no-op, but a
      // disabled-looking-enabled control is still wrong UI).
      this.emit();
    }
  }

  endUndoFrame(): void {
    const commands = this.frameCommands;
    this.frameCommands = null;
    if (!commands || commands.length === 0) return;
    // Count REAL stack growth (coalesced gestures replace the top entry
    // without pushing — the frame pops exactly what it added).
    const grew = this.undoStack.length - this.frameOpenDepth;
    if (grew <= 0) return;
    if (grew === 1) return; // already its own history entry
    const compound: Command = {
      type: "recordFrame",
      label: this.frameLabel,
      execute: (d) => commands.reduce((acc, c) => c.execute(acc), d),
      undo: (d) => [...commands].reverse().reduce((acc, c) => c.undo(acc), d),
    };
    for (let i = 0; i < grew; i++) {
      this.undoStack.pop();
      this.timestamps.pop();
    }
    this.undoStack.push(compound);
    this.timestamps.push(Date.now());
    // Collapse the per-command history snapshots: keep the before-frame state
    // plus the after-frame state (same pairing shape undo() maintains).
    // Audit 09 D2: slide the snapshot window (same semantics as
    // recordHistoryDoc) instead of stretching `historyDocs` to the raw stack
    // index — beyond the 64 cap that created empty holes and misaligned
    // diffForIndex offsets for every older entry.
    this.historyDocs.push(this.doc_);
    while (this.historyDocs.length > ProjectStore.HISTORY_LIMIT) this.historyDocs.shift();
    this.diffCache.clear();
    this.afterMutation();
  }

  undo(): void {
    const command = this.undoStack.pop();
    this.timestamps.pop();
    if (!command) return;
    let undone: ProjectDocument;
    try {
      undone = command.undo(this.doc_);
    } catch (err) {
      // A throwing undo must not eat the history entry: without restoring it
      // the command sat in NEITHER stack and the user lost the ability to
      // retry while the doc stayed at the applied state. Push back, rethrow.
      this.undoStack.push(command);
      this.timestamps.push(Date.now());
      throw err;
    }
    this.doc_ = normalizeProject(undone);
    this.redoStack.push(command);
    this.historyDocs.length = Math.min(this.historyDocs.length, this.undoStack.length + 1);
    this.historyDocs[this.historyDocs.length - 1] = this.doc_;
    // Snapshot index pairing shifted — drop the cache.
    this.diffCache.clear();
    this.afterMutation();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.doc_ = normalizeProject(command.execute(this.doc_));
    this.undoStack.push(command);
    this.timestamps.push(Date.now());
    this.diffCache.clear();
    this.recordHistoryDoc(this.doc_);
    this.afterMutation();
  }

  /**
   * Cubase-style history jump: undo/redo to the state after entry `index`
   * (0-based in the undo stack). One logical entry — no partial application.
   */
  jumpTo(index: number): void {
    // Audit 09 D1: seal an open record frame FIRST — jumping rewinds the
    // stack below `frameOpenDepth`, which corrupted the disarm bookkeeping
    // (the compound wrapped commands already undone by the jump, and redo
    // executed them a second time). Sealing leaves D as its own entry and
    // lets the jump build a coherent redo branch.
    if (this.frameCommands) this.endUndoFrame();
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
    // Audit 09 D4: an open record frame must die with the old document —
    // a later endUndoFrame would bake the old project's frame commands into
    // a compound and re-execute them against THIS document. (No live caller
    // today — project switches build a fresh store — landmine defusal.)
    this.frameCommands = null;
    this.historyDocs = [this.doc_];
    this.diffCache.clear();
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
