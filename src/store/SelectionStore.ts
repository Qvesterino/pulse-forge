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
}
