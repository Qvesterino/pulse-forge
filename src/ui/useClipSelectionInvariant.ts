import { useEffect } from "react";
import type { ProjectDocument } from "../project-model/types";
import type { SelectionStore } from "../store/SelectionStore";

/**
 * The slice of the document store this invariant needs.
 *
 * `services.store` is a union of `ProjectStore` and the collab `YDocStore`,
 * which deliberately mirrors the same public surface (`getDoc`, `subscribe`,
 * `execute`, `undo`) so callers do not care which is mounted. Typing the
 * parameter structurally keeps the hook honest for BOTH rather than
 * type-checking only the local case.
 */
export interface ClipSelectionSource {
  getDoc: () => ProjectDocument;
  subscribe: (listener: () => void) => () => void;
}

/**
 * SELECTION INVARIANT: every id in the selection names a live object.
 *
 * Commands are pure `ProjectDocument → Command` and cannot see the UI
 * selection, so a destructive clip action would otherwise have to prune its
 * own ids at its own call site. The track half of that contract already exists
 * (`SelectionStore.pruneTrack` / `retainTracks`, covered by
 * tests/selection-store-dead-refs.test.ts).
 *
 * The clip half did not. `App.tsx`'s keyboard Delete called
 * `selectionStore.clear()`, but the context menu, the DEL buttons and
 * `deleteClipsWithToast` cleared only the panel's local `selectedClipId` /
 * `selectedAudioClipId` — `clipIds` kept naming a clip that was gone. That
 * produced dead undo entries (the next Delete mapped `selection.clipIds`
 * through the live id sets, matched nothing, and still executed its
 * `deleteClips` command against an unchanged document) and kept the context
 * menu's clip actions enabled over a dead selection.
 *
 * Doing it once at the store boundary covers EVERY mutation source — buttons,
 * context menu, keyboard, MCP, the intent engine, collab and undo/redo —
 * because `ProjectStore.subscribe` fires on all of them.
 *
 * Pure and side-effect-light by design so it can be unit-tested directly
 * rather than only through a mounted panel.
 */
export function pruneDeadClipIds(store: ClipSelectionSource, selectionStore: SelectionStore): void {
  if (selectionStore.getState().clipIds.length === 0) return;
  const doc = store.getDoc();
  selectionStore.retainClips([
    ...doc.arrangement.clips.map((c) => c.id),
    ...(doc.arrangement.audioClips ?? []).map((c) => c.id),
  ]);
}

/**
 * Subscribe the invariant to every document mutation, and apply it once on
 * mount (a project can arrive with a selection that is already stale).
 *
 * Mounted by `App.tsx` — the component that OWNS the SelectionStore — so the
 * hook is not mounted by the panels it protects. Tests exercise
 * `pruneDeadClipIds` directly; the hook only adds the subscription.
 */
export function useClipSelectionInvariant(store: ClipSelectionSource, selectionStore: SelectionStore): void {
  useEffect(() => {
    pruneDeadClipIds(store, selectionStore);
    return store.subscribe(() => pruneDeadClipIds(store, selectionStore));
  }, [store, selectionStore]);
}
