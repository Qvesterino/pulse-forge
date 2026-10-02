export interface TimeRange {
  fromTick: number;
  toTick: number;
}

export interface NoteSelection {
  trackId: string;
  noteIds: string[];
}

export interface StepSelection {
  padIds: string[];
  from: number;
  to: number;
}

export interface SelectionState {
  trackIds: string[];
  clipIds: string[];
  noteSelections: NoteSelection[];
  stepSelection: StepSelection | null;
  timeRange: TimeRange | null;
}

type Listener = () => void;

export class SelectionStore {
  private state: SelectionState = {
    trackIds: [],
    clipIds: [],
    noteSelections: [],
    stepSelection: null,
    timeRange: null,
  };
  private listeners = new Set<Listener>();

  getState = (): SelectionState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  clear = (): void => {
    this.state = { trackIds: [], clipIds: [], noteSelections: [], stepSelection: null, timeRange: null };
    this.emit();
  };

  clearNotes = (): void => {
    if (this.state.noteSelections.length === 0 && !this.state.stepSelection) return;
    this.state = { ...this.state, noteSelections: [], stepSelection: null };
    this.emit();
  };

  clearTimeRange = (): void => {
    if (!this.state.timeRange) return;
    this.state = { ...this.state, timeRange: null };
    this.emit();
  };

  setTracks = (ids: string[], mode: "replace" | "add" | "range" = "replace", allTrackIds: string[] = []): void => {
    let next: string[];
    if (mode === "add") {
      const set = new Set(this.state.trackIds);
      for (const id of ids) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      next = [...set];
    } else if (mode === "range" && allTrackIds.length > 0 && this.state.trackIds.length > 0) {
      const last = this.state.trackIds[this.state.trackIds.length - 1];
      const a = allTrackIds.indexOf(last);
      const b = allTrackIds.indexOf(ids[0]);
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a];
        next = allTrackIds.slice(from, to + 1);
      } else {
        next = [...ids];
      }
    } else {
      next = [...ids];
    }
    this.state = { ...this.state, trackIds: next };
    this.emit();
  };

  setClips = (ids: string[], mode: "replace" | "add" | "range" = "replace", allClipIds: string[] = []): void => {
    let next: string[];
    if (mode === "add") {
      const set = new Set(this.state.clipIds);
      for (const id of ids) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      next = [...set];
    } else if (mode === "range" && allClipIds.length > 0 && this.state.clipIds.length > 0) {
      const last = this.state.clipIds[this.state.clipIds.length - 1];
      const a = allClipIds.indexOf(last);
      const b = allClipIds.indexOf(ids[0]);
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a];
        next = allClipIds.slice(from, to + 1);
      } else {
        next = [...ids];
      }
    } else {
      next = [...ids];
    }
    this.state = { ...this.state, clipIds: next };
    this.emit();
  };

  setNotes = (selection: NoteSelection | null, mode: "replace" | "add" | "range" = "replace"): void => {
    if (!selection) {
      this.state = { ...this.state, noteSelections: [] };
      this.emit();
      return;
    }
    if (mode === "replace") {
      this.state = { ...this.state, noteSelections: [selection], stepSelection: null, timeRange: null };
      this.emit();
      return;
    }
    // add / range for notes: merge per trackId
    const map = new Map<string, Set<string>>();
    for (const ns of this.state.noteSelections) {
      map.set(ns.trackId, new Set(ns.noteIds));
    }
    const existing = map.get(selection.trackId);
    if (mode === "add") {
      if (!existing) {
        map.set(selection.trackId, new Set(selection.noteIds));
      } else {
        for (const nid of selection.noteIds) {
          if (existing.has(nid)) existing.delete(nid);
          else existing.add(nid);
        }
        if (existing.size === 0) map.delete(selection.trackId);
      }
    } else {
      // range: for now treat as add (full range needs ordered note list)
      if (!existing) map.set(selection.trackId, new Set(selection.noteIds));
      else {
        for (const nid of selection.noteIds) existing.add(nid);
      }
    }
    const next: NoteSelection[] = [...map.entries()].map(([trackId, set]) => ({ trackId, noteIds: [...set] }));
    this.state = { ...this.state, noteSelections: next, stepSelection: null };
    this.emit();
  };

  setStepSelection = (sel: StepSelection | null): void => {
    this.state = {
      ...this.state,
      stepSelection: sel ? { padIds: [...sel.padIds], from: sel.from, to: sel.to } : null,
      noteSelections: [],
    };
    this.emit();
  };

  setTimeRange = (range: TimeRange | null): void => {
    if (!range) {
      if (!this.state.timeRange) return;
      this.state = { ...this.state, timeRange: null };
      this.emit();
      return;
    }
    const from = Math.min(range.fromTick, range.toTick);
    const to = Math.max(range.fromTick, range.toTick);
    if (from === to) {
      this.state = { ...this.state, timeRange: null };
      this.emit();
      return;
    }
    this.state = { ...this.state, timeRange: { fromTick: from, toTick: to } };
    this.emit();
  };

  isTrackSelected = (id: string): boolean => this.state.trackIds.includes(id);
  isClipSelected = (id: string): boolean => this.state.clipIds.includes(id);

  /**
   * Drop every reference to `trackId` from the selection. Called by the owner
   * of the destructive track action (the mixer strip's delete button — the
   * only UI call site of `deleteTrack`), because the selection is UI state
   * that the command itself cannot reach: `deleteTrack` strips the track's own
   * cross-references (automation lanes, audio clips) INSIDE the command so
   * undo restores them together, and the selection must follow the same
   * contract.
   *
   * The invariant this restores is "every id in the selection names a live
   * object", and the measured consequences of breaking it are:
   *
   *  - Zone bounce. `ArrangementPanel.bounceZoneToClip` passes
   *    `selection.trackIds` straight into `buildBounceZoneDoc` WITHOUT
   *    filtering against the live tracks (`App.tsx:1186`'s keyboard shortcut
   *    does filter — the button and the shortcut disagree). `buildBounceZoneDoc`
   *    resolves the ids through `buildStemProject(doc, t => trackIds.includes(t.id))`,
   *    which simply matches nothing for a dead id: no throw, no error toast,
   *    just an empty stem doc and a silent bounce. With a single selected track
   *    deleted, bouncing a zone returns silence while reporting success.
   *
   *  - Phantom pattern key. A surviving `noteSelections` entry keeps
   *    `ContextMenu`'s `hasNotes` true, so its delete action builds
   *    `deleteNotes(doc, <deleted id>, …)`. `activeTrackNotes` returns `[]` for
   *    an unknown track, so nothing throws — but `withTrackNotes` still writes
   *    `notes[<deleted id>] = []` back into the pattern, planting a phantom key
   *    in every save.
   *
   * Note the mixer's batch-FX toolbar is NOT one of the consequences: it
   * re-derives `selectedTracks` by filtering live tracks, so a dead id already
   * yields an empty target set and its documented "or all if none selected"
   * fallback behaves identically with or without the ghost.
   *
   * `stepSelection` holds pad ids, not track ids, so it is deliberately left
   * alone: its pads are addressed by drum track and a stale pad id is a
   * separate concern from deleting the track.
   *
   * No-ops without emitting when the track was not referenced, so this is safe
   * to call on every delete attempt.
   */
  pruneTrack = (trackId: string): void => {
    const trackIds = this.state.trackIds.filter((id) => id !== trackId);
    const noteSelections = this.state.noteSelections.filter((ns) => ns.trackId !== trackId);
    if (trackIds.length === this.state.trackIds.length && noteSelections.length === this.state.noteSelections.length)
      return;
    this.state = { ...this.state, trackIds, noteSelections };
    this.emit();
  };

  /**
   * Same invariant as `pruneTrack`, for call sites that removed an unknown
   * number of tracks and only know the survivors — currently the intent
   * engine's `removeTrack` op (`applyExactIntentCommand`), which deletes
   * through the same pure `deleteTrack` command and so faces the same
   * unreachable SelectionStore.
   *
   * `noteSelections` is filtered against the caller's live set rather than
   * derived from `trackIds`: a `noteSelections` entry can name a track that
   * was never in `trackIds` (notes selected without selecting the track), so
   * deriving the live set from the selection would drop that entry as well.
   */
  retainTracks = (liveIds: string[]): void => {
    const live = new Set(liveIds);
    const trackIds = this.state.trackIds.filter((id) => live.has(id));
    const noteSelections = this.state.noteSelections.filter((ns) => live.has(ns.trackId));
    if (trackIds.length === this.state.trackIds.length && noteSelections.length === this.state.noteSelections.length)
      return;
    this.state = { ...this.state, trackIds, noteSelections };
    this.emit();
  };

  /**
   * Same invariant as `retainTracks`, for clip ids.
   *
   * A clip selection is reachable from two clip systems — arrangement clips
   * (`arrangement.clips`) and audio clips (`arrangement.audioClips`) — and both
   * delete paths existed: the keyboard Delete in `App.tsx` calls
   * `selectionStore.clear()`, but the context menu, the DEL buttons and
   * `deleteClipsWithToast` cleared only the panel's local `selectedClipId` /
   * `selectedAudioClipId`. `clipIds` therefore kept naming a clip that was
   * gone.
   *
   * The measured consequences of leaving the ghost:
   *
   *  - Dead undo entries. The next Delete maps `selection.clipIds` through the
   *    live id sets and matches nothing, so the loop leaves the document
   *    untouched — but the caller still executes its `deleteClips` command with
   *    `execute: () => newDoc` where `newDoc === doc`. That is a no-op history
   *    entry the user has to press Ctrl+Z through.
   *  - The context menu keeps reporting `hasClips` for a deleted clip, so
   *    Duplicate / Consolidate / Split stay enabled over a dead selection and
   *    route to commands that resolve nothing.
   *
   * `timeRange` is deliberately untouched: it is a tick range, not an object
   * reference, so it cannot name a dead clip.
   *
   * Call with the union of BOTH live clip id sets. No-ops without emitting
   * when every selected id is still live.
   */
  retainClips = (liveIds: Iterable<string>): void => {
    const live = new Set(liveIds);
    const clipIds = this.state.clipIds.filter((id) => live.has(id));
    if (clipIds.length === this.state.clipIds.length) return;
    this.state = { ...this.state, clipIds };
    this.emit();
  };
}
