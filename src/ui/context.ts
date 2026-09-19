import { createContext, useContext, useSyncExternalStore } from "react";
import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import type { LibraryState } from "../persistence/LibraryRepository";
import type { LatencyCalibrationSnapshot } from "../audio-engine/latencyCalibration";
import type { ArrangementCaptureSnapshot } from "../arrangement/capture";
import type { SelectionState } from "../store/SelectionStore";
import { SelectionStore } from "../store/SelectionStore";
import type { Tool } from "../store/ToolStore";
import { ToolStore } from "../store/ToolStore";

const EMPTY_CAPTURE_SNAPSHOT: ArrangementCaptureSnapshot = { capturing: false, launchCount: 0, firstBar: null };
const EMPTY_CAPTURE = {
  subscribe: (_listener: () => void) => () => undefined,
  getSnapshot: (): ArrangementCaptureSnapshot => EMPTY_CAPTURE_SNAPSHOT,
};

/** Save status across both stores (YDocStore adds "syncing"). */
export type AppSaveStatus = "saved" | "dirty" | "saving" | "error" | "syncing";

export const ServicesContext = createContext<Services | null>(null);
export const SelectionContext = createContext<SelectionStore | null>(null);
export const ToolContext = createContext<ToolStore | null>(null);

const fallbackSelectionStore = new SelectionStore();
const fallbackToolStore = new ToolStore();

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("Services not initialized");
  return services;
}

export function useSelectionStore(): SelectionStore {
  return useContext(SelectionContext) ?? fallbackSelectionStore;
}

export function useSelection(): SelectionState {
  const store = useContext(SelectionContext) ?? fallbackSelectionStore;
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useToolStore(): ToolStore {
  const store = useContext(ToolContext);
  if (!store) throw new Error("ToolStore not initialized");
  return store;
}

export function useTool(): Tool {
  const store = useContext(ToolContext) ?? fallbackToolStore;
  return useSyncExternalStore(store.subscribe, store.getTool, store.getTool);
}

export function useDoc(): ProjectDocument {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getDoc, store.getDoc);
}

// ─── Fine-grained document slices ───────────────────────────────────────
// Each hook subscribes ONLY to its slice of the document. `normalizeProject`
// in src/project-model/schema.ts uses structural sharing, so when an
// unrelated slice changes (e.g. a track gain) the slice returned by the
// corresponding getX() helper stays referentially identical and the
// subscriber skips the re-render. Components that previously called
// useDoc() but only ever read `doc.scenes`, `doc.tracks`, etc. should
// switch to the matching fine-grained hook — the largest single win is
// `ArrangementPanel.tsx`, whose 23 `.map()` calls were forced to
// re-render on every undo/redo because it subscribed to the whole
// document through `useDoc()`.

export function useScenes(): ProjectDocument["scenes"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getScenes, store.getScenes);
}

export function useTracks(): ProjectDocument["tracks"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getTracks, store.getTracks);
}

export function useReturns(): ProjectDocument["returns"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getReturns, store.getReturns);
}

export function useArrangement(): ProjectDocument["arrangement"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getArrangement, store.getArrangement);
}

export function useMarkers(): ProjectDocument["markers"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getMarkers, store.getMarkers);
}

export function useAutomation(): ProjectDocument["automation"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getAutomation, store.getAutomation);
}

export function usePatterns(): ProjectDocument["patterns"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getPatterns, store.getPatterns);
}

export function useMacros(): ProjectDocument["macros"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getMacros, store.getMacros);
}

export function useMaster(): ProjectDocument["master"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getMaster, store.getMaster);
}

export function useSaveStatus(): AppSaveStatus {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getSaveStatus, store.getSaveStatus);
}

export function useLastSavedAt(): string | null {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getLastSavedAt, store.getLastSavedAt);
}

/** True iff the project has at least one command in its undo stack. */
export function useCanUndo(): boolean {
  const { store } = useServices();
  return useSyncExternalStore(
    store.subscribe,
    () => store.canUndo,
    () => false,
  );
}

/** True iff the project has at least one command in its redo stack. */
export function useCanRedo(): boolean {
  const { store } = useServices();
  return useSyncExternalStore(
    store.subscribe,
    () => store.canRedo,
    () => false,
  );
}

/** Reactive browser-local audio/MIDI timing preferences. */
export function useLatencyCalibration(): LatencyCalibrationSnapshot {
  const { latency } = useServices();
  return useSyncExternalStore(latency.subscribe, latency.getSnapshot, latency.getSnapshot);
}

export function useArrangementCapture(): ArrangementCaptureSnapshot {
  const { capture } = useServices();
  const source = capture ?? EMPTY_CAPTURE;
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** Reactive favorites/recent state for the sample & preset browsers. */
export function useLibrary(): LibraryState {
  const { core } = useServices();
  return useSyncExternalStore(
    (cb) => core.library.subscribe(() => cb()),
    () => core.library.get(),
    () => core.library.get(),
  );
}
