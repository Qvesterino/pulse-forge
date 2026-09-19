/**
 * Remote presence cursors for the editors.
 *
 * Local users publish where they hover (sequencer cell, piano roll cell) via
 * CollabSession.setCursor → awareness; editors render colored markers for
 * everyone else's cursor. Publication only happens on cell *change*, so the
 * awareness traffic is a few bytes per cell crossing, not per mousemove.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { RemoteCursor } from "../collab/CollaborationProvider";
import type { CursorState } from "../collab/CollaborationProvider";
import { useServices } from "./context";

const EMPTY: RemoteCursor[] = [];

/** Reactive snapshot of everyone else's cursor (awareness-driven). */
export function useRemoteCursors(): RemoteCursor[] {
  const services = useServices();
  const subscribe = useCallback(
    (listener: () => void) => services.collab?.subscribe(listener) ?? (() => {}),
    [services],
  );
  const snapshot = useCallback(() => services.collab?.remoteCursors ?? EMPTY, [services]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Stable callback that broadcasts the local cursor (no-op without collab). */
export function usePublishCursor(): (cursor: CursorState | null) => void {
  const services = useServices();
  return useCallback((cursor: CursorState | null) => services.collab?.setCursor(cursor), [services]);
}

/** Users whose cursor sits on this exact cell (used to render markers). */
export function cursorsAt(cursors: RemoteCursor[], match: Partial<CursorState>): RemoteCursor[] {
  return cursors.filter(({ cursor }) =>
    Object.entries(match).every(([key, value]) =>
      value === undefined ? cursor[key as keyof CursorState] === undefined : cursor[key as keyof CursorState] === value,
    ),
  );
}
