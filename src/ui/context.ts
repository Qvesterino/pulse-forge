import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import { modulationOwnership, type ModulationOwnership } from "../project-model/modulation-precedence";
import type { GenerativeStatus } from "../generative/types";
import type { LibraryState } from "../persistence/LibraryRepository";
import type { LatencyCalibrationSnapshot } from "../audio-engine/latencyCalibration";
import type { ArrangementCaptureSnapshot } from "../arrangement/capture";
import type { SelectionState } from "../store/SelectionStore";
import type { RecoveryStatus } from "../store/ProjectStore";
import {
  getUserSampleRestoreStatus,
  subscribeUserSampleRestoreStatus,
  type UserSampleRestoreStatus,
} from "../persistence/userSampleRestoreStatus";
import { SelectionStore } from "../store/SelectionStore";
import { mcpAllowDestructive, mcpAllowMutations, subscribeMcpFlags } from "../mcp/flags";
import {
  getAudibleVerification,
  subscribeAudibleVerification,
  type AudibleVerificationNotice,
} from "../analysis/audible-verification-store";
import {
  getSessionRecordingState,
  subscribeSessionRecordingState,
  type SessionRecordingState,
} from "./sessionStateSurface";
import type { Tool } from "../store/ToolStore";
import { ToolStore } from "../store/ToolStore";

const EMPTY_CAPTURE_SNAPSHOT: ArrangementCaptureSnapshot = {
  capturing: false,
  launchCount: 0,
  firstBar: null,
  livePads: [],
  message: null,
};
const EMPTY_GENERATIVE_STATUS: GenerativeStatus = { state: "idle" };
const EMPTY_GENERATIVE_RUNTIME = {
  subscribe: (_listener: (trackId: string, status: GenerativeStatus) => void) => () => undefined,
  getStatus: (_trackId: string): GenerativeStatus => EMPTY_GENERATIVE_STATUS,
};
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
  // Provider-less fallback (same contract as the selection store): tests and
  // provider-less surfaces share one module instance; the app mounts the real
  // store through the provider. The old throwing variant had zero consumers —
  // a hook that crashes the panel it serves was speculation, not safety.
  return useContext(ToolContext) ?? fallbackToolStore;
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

export function useSceneAutomation(): ProjectDocument["sceneAutomation"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getSceneAutomation, store.getSceneAutomation);
}

/**
 * Modulation ownership — who drives which device parameter (ADR 0067).
 *
 * The ownership is derived from three slices (automation lanes, LFOs, macros),
 * so the hook subscribes to exactly those: a lane added or removed has to
 * re-render the surface that discloses the owner, and an unrelated edit (a
 * track gain) must not.
 *
 * The DOCUMENT itself is read through the plain getter at render time — it is
 * fresh, because the re-render was triggered by one of the slices above. (A
 * surface that reads a slice without subscribing to it would show a stale
 * owner forever — the F-09/F-10 staleness defect.)
 */
export function useModulationOwnership(): ModulationOwnership {
  const { store } = useServices();
  useSyncExternalStore(store.subscribe, store.getAutomation, store.getAutomation);
  useSyncExternalStore(store.subscribe, store.getLfos, store.getLfos);
  useSyncExternalStore(store.subscribe, store.getMacros, store.getMacros);
  const doc = store.getDoc();
  return useMemo(() => modulationOwnership(doc), [doc]);
}

export function useActivePatternId(): ProjectDocument["activePatternId"] {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getActivePatternId, store.getActivePatternId);
}

export function useSaveStatus(): AppSaveStatus {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getSaveStatus, store.getSaveStatus);
}

export function useLastSavedAt(): string | null {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getLastSavedAt, store.getLastSavedAt);
}

/**
 * Whether the crash buffer can hold this project.
 *
 * `unprotected` means a closed tab cannot be recovered — the user has to be
 * told while they can still save, not after the work is gone.
 */
export function useRecoveryStatus(): RecoveryStatus {
  const { store } = useServices();
  // Arrow wrappers, not method references: `store.getRecoveryStatus` handed to
  // useSyncExternalStore unbound loses `this` and reads off undefined.
  return useSyncExternalStore(
    store.subscribe,
    () => store.getRecoveryStatus(),
    () => store.getRecoveryStatus(),
  );
}

/**
 * Which of the user's own saved audio came back after a reload.
 *
 * A sample that could not be decoded used to be skipped in silence — the
 * recorded take that used it was permanently silent and the user was never
 * told. The state is published by the boot restore, so the UI can say it out
 * loud and offer a retry.
 */
export function useUserSampleRestoreStatus(): UserSampleRestoreStatus {
  return useSyncExternalStore(subscribeUserSampleRestoreStatus, getUserSampleRestoreStatus, getUserSampleRestoreStatus);
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

/** Reactive provider/session status for one persisted generative track. */
export function useGenerativeStatus(trackId: string): GenerativeStatus {
  const { generativeRuntime: serviceRuntime } = useServices();
  const generativeRuntime = serviceRuntime ?? EMPTY_GENERATIVE_RUNTIME;
  return useSyncExternalStore(
    (listener) => generativeRuntime.subscribe((changedTrackId) => changedTrackId === trackId && listener()),
    () => generativeRuntime.getStatus(trackId),
    () => generativeRuntime.getStatus(trackId),
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

/** Reactive MCP delete authority — shared by the TopBar badge and the toggles. */
export function useMcpAllowDestructive(): boolean {
  return useSyncExternalStore(subscribeMcpFlags, mcpAllowDestructive, mcpAllowDestructive);
}

/** Reactive MCP edit consent (ADR 0065). */
export function useMcpAllowMutations(): boolean {
  return useSyncExternalStore(subscribeMcpFlags, mcpAllowMutations, mcpAllowMutations);
}

/** Reactive audio-recording surface published by the arrangement REC strip. */
export function useSessionRecordingState(): SessionRecordingState {
  return useSyncExternalStore(subscribeSessionRecordingState, getSessionRecordingState, getSessionRecordingState);
}

/** Last audible-verification comparison (null until a compare runs). */
export function useAudibleVerification(): AudibleVerificationNotice | null {
  return useSyncExternalStore(subscribeAudibleVerification, getAudibleVerification, getAudibleVerification);
}

/** Current document revision (null when the store cannot report one). */
export function useDocRevision(): number | null {
  const { store } = useServices();
  return useSyncExternalStore(
    store.subscribe,
    () => ("getRevision" in store && typeof store.getRevision === "function" ? store.getRevision() : null),
    () => null,
  );
}
