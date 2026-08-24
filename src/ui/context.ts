import { createContext, useContext, useSyncExternalStore } from "react";
import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import type { LibraryState } from "../persistence/LibraryRepository";
import type { LatencyCalibrationSnapshot } from "../audio-engine/latencyCalibration";

/** Save status across both stores (YDocStore adds "syncing"). */
export type AppSaveStatus = "saved" | "dirty" | "saving" | "error" | "syncing";

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("Services not initialized");
  return services;
}

export function useDoc(): ProjectDocument {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getDoc, store.getDoc);
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
  return useSyncExternalStore(
    latency.subscribe,
    latency.getSnapshot,
    latency.getSnapshot,
  );
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
