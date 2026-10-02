/**
 * SESSION STATE SURFACE — what is "hot" right now, published by the
 * arrangement REC strip and consumed by the always-visible session state
 * indicator (footer). Recording-adjacent axes live as React state inside
 * ArrangementPanel; other views (sequencer, mixer focus) need to see them
 * without scrolling, so the panel publishes a snapshot here.
 *
 * Tiny observable: publish merges shallowly and skips notification when
 * nothing changed (the panel re-runs its publish effect on unrelated
 * re-renders — the indicator must not).
 */

export type SessionRecState = "idle" | "starting" | "recording" | "saving";

export interface SessionRecordingState {
  /** Display names of armed tracks, in channel order. Empty = nothing armed. */
  armedTrackNames: string[];
  recState: SessionRecState;
  /** Pre-formatted punch locator range ("9.1 → 13"), null when not arming punch. */
  punchRange: string | null;
  loopTakes: boolean;
  /** Take-group label when a non-empty take mode is selected. */
  takeModeLabel: string | null;
}

export const IDLE_SESSION_STATE: SessionRecordingState = {
  armedTrackNames: [],
  recState: "idle",
  punchRange: null,
  loopTakes: false,
  takeModeLabel: null,
};

let state: SessionRecordingState = IDLE_SESSION_STATE;
const listeners = new Set<() => void>();

function shallowEqual(a: SessionRecordingState, b: SessionRecordingState): boolean {
  return (
    a.recState === b.recState &&
    a.punchRange === b.punchRange &&
    a.loopTakes === b.loopTakes &&
    a.takeModeLabel === b.takeModeLabel &&
    a.armedTrackNames.length === b.armedTrackNames.length &&
    a.armedTrackNames.every((name, index) => name === b.armedTrackNames[index])
  );
}

/** Merge a partial patch into the surface; notifies only on a real change. */
export function publishSessionRecordingState(patch: Partial<SessionRecordingState>): void {
  const next = { ...state, ...patch };
  if (shallowEqual(state, next)) return;
  state = next;
  for (const listener of listeners) listener();
}

export function getSessionRecordingState(): SessionRecordingState {
  return state;
}

export function subscribeSessionRecordingState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when any axis is active — the indicator hides on an all-idle surface. */
export function isSessionStateActive(state: SessionRecordingState): boolean {
  return (
    state.armedTrackNames.length > 0 ||
    state.recState !== "idle" ||
    state.punchRange !== null ||
    state.loopTakes ||
    state.takeModeLabel !== null
  );
}
