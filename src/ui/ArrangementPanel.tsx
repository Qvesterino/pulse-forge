import { useCallback, useEffect, useRef, useState } from "react";
import {
  useArrangement,
  useArrangementCapture,
  useMarkers,
  usePatterns,
  useScenes,
  useSelection,
  useSelectionStore,
  useServices,
  useTracks,
} from "./context";
import { useActivePatternId } from "./context";
import { SpectralEditPanel } from "./SpectralEditPanel";
import {
  addArrangementClip,
  addArrangementTransition,
  addAudioClip,
  addMarker,
  consolidateAudioClips,
  autoArrangeSong,
  generatePatternCommand,
  createArrangementSkeleton,
  createScene,
  createVariationAndPlaceClip,
  deleteArrangementClip,
  deleteAudioClip,
  deleteScene,
  duplicateArrangementClip,
  duplicateAudioClip,
  duplicatePatternForScene,
  duplicateSceneAsVariation,
  fitAudioClipTempo,
  stealGrooveIntoPattern,
  moveArrangementClip,
  moveAudioClip,
  removeArrangementTransition,
  removeMarker,
  renameScene,
  reorderScenes,
  resizeArrangementClip,
  setSceneIntensityCurve,
  setSceneRole,
  resizeAudioClip,
  splitAudioClipAtTick,
  stripSilenceAudioClip,
  updateArrangementTransition,
  updateAudioClip,
  sliceToPads,
} from "../commands/commands";
import { sceneRoleOf } from "../project-model/schema";
import { effectiveSceneBpm, sceneBarsToSeconds, sceneSecondsToBars } from "../project-model/scene-time";
import { computeSceneIntensity } from "../project-model/intensity";
import type {
  ArrangementClip,
  ArrangementTransitionType,
  AudioClip,
  IntensityPoint,
  ProjectDocument,
  SceneRole,
} from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { warpBufferTimeAtTick } from "../audio-engine/AudioEngine";
import { nearestOnset } from "../audio-workers/onset-detector";
import { extractGroove } from "../audio-engine/groove-extract";
import { detectTransientsAsync } from "../audio-workers/onset-detector-client";
import { analyzeLoopForFlip, buildFlipOptions, flipSeed } from "../ai/flip";
import { recordedTakeSampleId, userSampleId } from "../persistence/UserSampleRepository";
import { RECORDING_OWNER_ID, type RecordingSession } from "../persistence/RecordingRecoveryRepository";
import { materializePcmTake } from "../audio-engine/pcmRecording";
import { recordingAlignment } from "../audio-engine/recordingAlignment";
import {
  listRecordingInputDevices,
  loadRecordingInputDeviceId,
  loadRecordingInputGainDb,
  saveRecordingInputDeviceId,
  saveRecordingInputGainDb,
  type RecordingInputDevice,
} from "../audio-engine/recordingInput";
import { clampInputGainDb, MAX_INPUT_GAIN_DB, MIN_INPUT_GAIN_DB } from "../audio-engine/PcmMicRecorder";
import { buildBounceZoneDoc } from "../rendering/bounce";
import { renderProject } from "../rendering/renderer";
import { encodeWav } from "../rendering/wav";
import {
  addRecordedAudioClip,
  clipLengthBars,
  compensateRecordingStartBar,
  recordedTakeAlreadyPlaced,
  recordingStartBar,
} from "./timelineRec";
import { usePlayheadBar } from "./playhead";
import { SceneLauncher, useSceneRuntimeState } from "./SceneLauncher";

const BASE_BAR_WIDTH = 30;
const LANE_HEIGHT = 56;
/**
 * Transient times (sec) per audio buffer for the warp-pin magnet. Module
 * scope: detection is async (worker for long samples) and outlives renders.
 * A placement miss simply stays un-snapped and kicks off detection, so the
 * next pin on the same buffer snaps.
 */
const warpOnsetCache = new Map<string, number[]>();
const warpOnsetInflight = new Set<string>();
/** Grab radius of the transient magnet around the pointed sample time. */
const WARP_SNAP_SEC = 0.06;
/** Shared in-flight onset renders so parallel warmers/hooks never double-detect. */
const warpOnsetPromises = new Map<string, Promise<number[]>>();

function sameRecordingInputDevices(a: RecordingInputDevice[], b: RecordingInputDevice[]): boolean {
  return (
    a.length === b.length &&
    a.every((device, index) => device.deviceId === b[index].deviceId && device.label === b[index].label)
  );
}

/** Parse `#rrggbb` (or `#rgb`) into [r, g, b]; null when unparseable. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^\s*#([0-9a-f]{6}|[0-9a-f]{3})\s*$/i.exec(hex);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const int = parseInt(h, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/**
 * Transient times for a buffer, shared across warmers and waveform hooks:
 * cache hit resolves immediately, otherwise detection runs once (worker for
 * long samples) and every waiter resolves from the same promise.
 */
function getWarpOnsets(
  bank: { get(bufferId: string): AudioBuffer | null | undefined },
  bufferId: string,
): Promise<number[]> | null {
  const cached = warpOnsetCache.get(bufferId);
  if (cached) return Promise.resolve(cached);
  const inflight = warpOnsetPromises.get(bufferId);
  if (inflight) return inflight;
  const buf = bank.get(bufferId);
  if (!buf || !(buf.duration > 0) || buf.duration > 600) return null;
  warpOnsetInflight.add(bufferId);
  const p = detectTransientsAsync(buf.getChannelData(0), buf.sampleRate).then(
    (times) => {
      warpOnsetCache.set(bufferId, times);
      warpOnsetPromises.delete(bufferId);
      warpOnsetInflight.delete(bufferId);
      return times;
    },
    () => {
      warpOnsetPromises.delete(bufferId);
      warpOnsetInflight.delete(bufferId);
      return [];
    },
  );
  warpOnsetPromises.set(bufferId, p);
  return p;
}
const SCENE_ROLES: Array<{ value: SceneRole | ""; label: string }> = [
  { value: "", label: "INFER FROM NAME" },
  { value: "intro", label: "INTRO" },
  { value: "build", label: "BUILD" },
  { value: "drop", label: "DROP" },
  { value: "break", label: "BREAK" },
  { value: "outro", label: "OUTRO" },
  { value: "fill", label: "FILL" },
  { value: "verse", label: "VERSE" },
  { value: "chorus", label: "CHORUS" },
  { value: "bridge", label: "BRIDGE" },
  { value: "custom", label: "CUSTOM" },
];
const TRANSITION_TYPES: ArrangementTransitionType[] = ["fill", "riser", "impact", "drop", "break", "custom"];

interface DragState {
  mode: "move" | "resize";
  clipId: string;
  origStart: number;
  origLength: number;
  grabBar: number;
  /** Multi-select move: every selected clip id + its start when the drag began. */
  movingIds?: string[];
  origStarts?: Record<string, number>;
}

interface TransitionBoundary {
  fromClipId: string;
  toClipId: string;
}

interface TransitionDraft {
  type: ArrangementTransitionType;
  lengthBars: number;
  cueAssetId: string;
}

export function ArrangementPanel() {
  const services = useServices();
  // Fine-grained selectors (GOAL 04): ArrangementPanel reads scenes, the
  // arrangement (clips, audioClips, transitions), tracks, markers, patterns
  // and the active pattern id. Subscribing to the whole document via
  // `useDoc()` re-renders this whole panel on every unrelated mutation
  // (a track-mute, a marker add, an automation-point move). With structural
  // sharing in `normalizeProject`, the slices we actually read keep their
  // array identity across most edits, so a fine-grained `useSyncExternalStore`
  // subscription skips the re-render.
  const scenes = useScenes();
  const arrangement = useArrangement();
  const tracks = useTracks();
  const markers = useMarkers();
  const patterns = usePatterns();
  const activePatternId = useActivePatternId();
  // `doc` is still needed for the BPM scalar, the project id, and command
  // arguments. It's a plain getter (no React subscription).
  const doc = services.store.getDoc();
  const capture = useArrangementCapture();
  const [selectedSceneId, setSelectedSceneId] = useState(scenes[0]?.id ?? "");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [rulerMode, setRulerMode] = useState<"bars" | "seconds">("bars");
  const [showIntensity, setShowIntensity] = useState(true);
  // Arrangement zoom: px per bar = BASE_BAR_WIDTH * zoom. Ctrl+wheel zooms
  // around the cursor, −/+ step, FIT squeezes the whole song into the view.
  const [zoom, setZoom] = useState(1);
  const barWidth = BASE_BAR_WIDTH * zoom;
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const zoomAnchorRef = useRef<{ tick: number; cursorX: number } | null>(null);
  zoomRef.current = zoom;
  const [showSkeletonPreview, setShowSkeletonPreview] = useState(false);
  const [transitionBoundary, setTransitionBoundary] = useState<TransitionBoundary | null>(null);
  const [transitionDraft, setTransitionDraft] = useState<TransitionDraft>({
    type: "custom",
    lengthBars: 1,
    cueAssetId: "",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  // Clip multi-select: marquee on empty-lane drag, ctrl/shift+click toggles.
  // The ids live in the shared SelectionStore — keyboard Delete, the P
  // (locators to selection) shortcut and the context menu already read them.
  const [marquee, setMarquee] = useState<{ from: number; to: number } | null>(null);
  const marqueeStartRef = useRef<number | null>(null);
  const [multiDrag, setMultiDrag] = useState<number | null>(null);
  const [deleteToast, setDeleteToast] = useState<{ label: string } | null>(null);
  // SCENE SECS authoring (VISION §10): type a wall-clock duration for the
  // selected clip — committed as whole bars at the clip's effective tempo.
  const [secsDraft, setSecsDraft] = useState<string | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<{ startBar: number; lengthBars: number } | null>(null);
  const playheadBar = usePlayheadBar(services.transport);
  const selection = useSelection();
  const selectionStore = useSelectionStore();
  const [timeDrag, setTimeDrag] = useState<{ startBar: number; currentBar: number } | null>(null);
  const runtime = useSceneRuntimeState();
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);
  // ── Timeline recording: arm a track, REC the mic straight into the song ──
  const [armedTrackId, setArmedTrackId] = useState<string>("");
  const [recState, setRecState] = useState<"idle" | "starting" | "recording" | "saving">("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [micMonitoring, setMicMonitoring] = useState(false);
  const [recordingInputDeviceId, setRecordingInputDeviceId] = useState(loadRecordingInputDeviceId);
  const [recordingInputDevices, setRecordingInputDevices] = useState<RecordingInputDevice[]>([]);
  const [recordingInputListError, setRecordingInputListError] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const recRef = useRef<import("../audio-engine/PcmMicRecorder").PcmMicRecorder | null>(null);
  const recStartPendingRef = useRef(false);
  const recStartAttemptRef = useRef(0);
  const recPanelMountedRef = useRef(true);
  const stoppingRecRef = useRef(false);
  const recoveryRepoRef = useRef(services.recordingRecovery);
  const [recoverableTakes, setRecoverableTakes] = useState<RecordingSession[]>([]);
  const recoverableTakesRef = useRef<RecordingSession[]>([]);
  const [recoveringTakeId, setRecoveringTakeId] = useState<string | null>(null);
  const sliceAnalysisRef = useRef<AbortController | null>(null);

  const refreshRecordingInputs = useCallback(async (): Promise<void> => {
    try {
      const devices = await listRecordingInputDevices();
      if (recPanelMountedRef.current) {
        setRecordingInputDevices((current) => (sameRecordingInputDevices(current, devices) ? current : devices));
        setRecordingInputListError(false);
      }
    } catch {
      if (recPanelMountedRef.current) setRecordingInputListError(true);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const refresh = async () => {
      try {
        const devices = await listRecordingInputDevices(mediaDevices ?? null);
        if (live) {
          setRecordingInputDevices((current) => (sameRecordingInputDevices(current, devices) ? current : devices));
          setRecordingInputListError(false);
        }
      } catch {
        if (live) setRecordingInputListError(true);
      }
    };
    void refresh();
    mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      live = false;
      mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const publishRecoverableTakes = useCallback((sessions: RecordingSession[]): void => {
    const current = recoverableTakesRef.current;
    const unchanged =
      current.length === sessions.length &&
      current.every(
        (session, index) =>
          session.id === sessions[index].id &&
          session.updatedAt === sessions[index].updatedAt &&
          session.totalFrames === sessions[index].totalFrames,
      );
    if (!unchanged) {
      recoverableTakesRef.current = sessions;
      setRecoverableTakes(sessions);
    }
  }, []);

  const refreshRecoverableTakes = useCallback(async (): Promise<void> => {
    try {
      publishRecoverableTakes(await recoveryRepoRef.current!.listRecoverable(Date.now(), RECORDING_OWNER_ID));
    } catch {
      setRecError("Could not check local recording recovery storage. Your current project is unchanged.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void recoveryRepoRef.current!.listRecoverable(Date.now(), RECORDING_OWNER_ID).then(
        (sessions) => {
          if (live) publishRecoverableTakes(sessions);
        },
        () => {
          if (live) setRecError("Could not check local recording recovery storage. Your current project is unchanged.");
        },
      );
    };
    refresh();
    // A take in another tab becomes recoverable after its last committed
    // block goes stale; poll slowly rather than depending on the UI frame loop.
    const timer = setInterval(refresh, 3_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [doc.id, publishRecoverableTakes]);

  // Ctrl+wheel zoom on the arrangement — needs a NON-passive native listener
  // (React 17+ attaches wheel passively at the root, so preventDefault in
  // onWheel is ignored and the browser zooms the page instead).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const tickAtCursor = ((el.scrollLeft + cursorX) / (BASE_BAR_WIDTH * zoomRef.current)) * BAR_TICKS;
      const next = Math.min(4, Math.max(0.35, zoomRef.current * Math.exp(-event.deltaY * 0.002)));
      if (next === zoomRef.current) return;
      // Keep the tick under the cursor stable across the zoom.
      zoomAnchorRef.current = { tick: tickAtCursor, cursorX };
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Re-anchor the scroll position after a zoom render.
  useEffect(() => {
    const el = scrollRef.current;
    const anchor = zoomAnchorRef.current;
    if (!el || !anchor) return;
    el.scrollLeft = Math.max(0, (anchor.tick / BAR_TICKS) * (BASE_BAR_WIDTH * zoom) - anchor.cursorX);
    zoomAnchorRef.current = null;
  }, [zoom]);

  // Actionable delete toast — dismisses itself; UNDO stays available while shown.
  useEffect(() => {
    if (!deleteToast) return;
    const id = setTimeout(() => setDeleteToast(null), 6000);
    return () => clearTimeout(id);
  }, [deleteToast]);

  // A recorder left running at unmount (panel switch, project close) would
  // keep the mic stream and its chunk buffer alive forever.
  useEffect(() => {
    recPanelMountedRef.current = true;
    return () => {
      recPanelMountedRef.current = false;
      recStartAttemptRef.current++;
      recStartPendingRef.current = false;
      const recorder = recRef.current;
      recRef.current = null;
      if (recorder) {
        recorder.onError = null;
        void recorder.cancel();
      }
      sliceAnalysisRef.current?.abort();
      sliceAnalysisRef.current = null;
    };
  }, []);

  const startRec = async () => {
    if (!armedTrackId || recState !== "idle" || recRef.current || recStartPendingRef.current) return;
    recStartPendingRef.current = true;
    const attempt = ++recStartAttemptRef.current;
    setRecState("starting");
    setRecError(null);
    let recorder: import("../audio-engine/PcmMicRecorder").PcmMicRecorder | null = null;
    try {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) throw new Error("Audio engine is not ready");
      // Load the PCM capture engine only when the user starts a vocal take.
      const { PcmMicRecorder } = await import("../audio-engine/PcmMicRecorder");
      // The component may have unmounted while the lazy module was loading.
      if (!recPanelMountedRef.current || attempt !== recStartAttemptRef.current) return;
      recorder = new PcmMicRecorder({
        ctx,
        recovery: recoveryRepoRef.current!,
        inputDeviceId: recordingInputDeviceId,
      });
      // Publish ownership before the permission prompt/async start so an
      // unmount or a second REC action can cancel this exact pending take.
      recRef.current = recorder;
      recorder.setMonitoring(micMonitoring);
      const startPromise = recorder.start(() => {
        const currentDoc = services.store.doc;
        const track = currentDoc.tracks.find((item) => item.id === armedTrackId);
        if (!track) return null;
        const startBar = Math.max(0, recordingStartBar(services.transport.position));
        return {
          projectId: currentDoc.id,
          trackId: track.id,
          trackName: track.name,
          placeOnTimeline: true,
          startBar,
          bpm: currentDoc.bpm,
          recordingInputOffsetMs: recordingAlignment.getSnapshot(),
        };
      });
      recorder.onError = (message) => {
        setRecError(message);
        void stopRec();
      };
      await startPromise;
      // An error during the "starting" phase already routed this take through
      // stopRec, which cleared the recorder slot. If start() resolved anyway
      // (late permission/resume), don't resurrect the recording state or the
      // recorder — a fresh take may already own the slot.
      if (!recPanelMountedRef.current || attempt !== recStartAttemptRef.current || recRef.current !== recorder) {
        void recorder.cancel();
        return;
      }
      setRecSeconds(0);
      setRecState("recording");
      void refreshRecordingInputs();
      // Performers record against the backing track — roll the transport.
      if (!services.transport.playing) services.playback.playPause();
    } catch (error) {
      if (recorder) {
        if (recRef.current === recorder) recRef.current = null;
        void recorder.cancel();
      }
      if (recPanelMountedRef.current && attempt === recStartAttemptRef.current) {
        setRecState("idle");
        setRecError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (attempt === recStartAttemptRef.current) recStartPendingRef.current = false;
    }
  };

  const stopRec = async () => {
    const rec = recRef.current;
    if (!rec || stoppingRecRef.current) return;
    stoppingRecRef.current = true;
    setRecState("saving");
    try {
      const take = await rec.stop();
      if (!take) {
        setRecError("No audio was captured. Any staged audio remains available in recovery.");
        return;
      }
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const bufferId = recordedTakeSampleId(take.session.id);
      const asset = {
        id: bufferId,
        name: `REC ${stamp}`,
        fileName: `${bufferId}.wav`,
        category: "Custom" as const,
        duration: take.buffer.duration,
        sampleRate: take.buffer.sampleRate,
        channels: take.buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
      };
      let persistenceWarning: string | null = null;
      try {
        await recoveryRepoRef.current!.finalize(take.session.id, asset);
        services.userSamples.invalidateCache();
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : "";
        persistenceWarning = `The take could not be moved to the sample library${detail}. Its committed PCM blocks remain in recovery storage.`;
      }

      // Keep the materialized audio usable in-session even if library storage
      // failed; in that case the staged PCM session remains crash-recoverable.
      services.bank.add(bufferId, take.buffer);
      try {
        const currentDoc = services.store.doc;
        if (
          currentDoc.id !== take.session.projectId ||
          !currentDoc.tracks.some((track) => track.id === take.session.trackId)
        ) {
          throw new Error("The original project or armed track is no longer open");
        }
        services.store.execute(
          addRecordedAudioClip(
            currentDoc,
            take.session.trackId,
            bufferId,
            compensateRecordingStartBar(
              take.session.startBar,
              take.session.recordingInputOffsetMs ?? 0,
              currentDoc.bpm,
            ),
            clipLengthBars(take.buffer.duration, currentDoc.bpm),
            {
              fadeIn: 0.005,
              fadeOut: 0.02,
            },
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        persistenceWarning = [
          persistenceWarning,
          `${persistenceWarning ? "The take remains in recovery storage" : "The take is saved as a sample"}, but could not be placed on the timeline: ${detail}.`,
        ]
          .filter(Boolean)
          .join(" ");
      }
      if (persistenceWarning) setRecError(persistenceWarning);
      await refreshRecoverableTakes();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setRecError(`${detail}. The staged recording has been kept for recovery where storage succeeded.`);
      await refreshRecoverableTakes();
    } finally {
      if (recRef.current === rec) recRef.current = null;
      setRecState("idle");
      stoppingRecRef.current = false;
    }
  };

  const recoverTake = async (session: RecordingSession) => {
    if (recoveringTakeId) return;
    setRecoveringTakeId(session.id);
    setRecError(null);
    try {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) throw new Error("Audio engine is not ready to open the recovered take");
      // Turn a stale cross-tab capture into a stopped session before reading
      // blocks, so a still-open source tab cannot extend it mid-recovery.
      await recoveryRepoRef.current!.markRecoverable(session.id);
      const take = await materializePcmTake(recoveryRepoRef.current!, session.id, ctx);
      const bufferId = recordedTakeSampleId(session.id);
      const asset = {
        id: bufferId,
        name: `RECOVERED ${session.trackName}`,
        fileName: `${bufferId}.wav`,
        category: "Custom" as const,
        duration: take.buffer.duration,
        sampleRate: take.buffer.sampleRate,
        channels: take.buffer.numberOfChannels,
        createdAt: new Date().toISOString(),
      };
      await recoveryRepoRef.current!.finalize(session.id, asset);
      services.userSamples.invalidateCache();
      services.bank.add(bufferId, take.buffer);

      const currentDoc = services.store.doc;
      const originalTrackExists =
        session.placeOnTimeline !== false &&
        currentDoc.id === session.projectId &&
        currentDoc.tracks.some((track) => track.id === session.trackId);
      if (originalTrackExists) {
        if (recordedTakeAlreadyPlaced(currentDoc, bufferId)) {
          setRecError(`Recovered ${session.trackName}; its existing timeline clip now has restored audio.`);
          await refreshRecoverableTakes();
          return;
        }
        try {
          services.store.execute(
            addRecordedAudioClip(
              currentDoc,
              session.trackId,
              bufferId,
              compensateRecordingStartBar(session.startBar, session.recordingInputOffsetMs ?? 0, currentDoc.bpm),
              clipLengthBars(take.buffer.duration, currentDoc.bpm),
              { fadeIn: 0.005, fadeOut: 0.02 },
            ),
          );
          setRecError(`Recovered ${session.trackName} and placed it back on the timeline.`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setRecError(`Take recovered to the sample library, but timeline placement failed: ${detail}`);
        }
      } else {
        setRecError("Recovered take to the sample library; its original project or track is not open.");
      }
      await refreshRecoverableTakes();
    } catch (error) {
      setRecError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveringTakeId(null);
    }
  };

  const discardTake = async (session: RecordingSession) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Permanently discard the unrecovered take from ${session.trackName}?`)
    )
      return;
    try {
      await recoveryRepoRef.current!.remove(session.id);
      await refreshRecoverableTakes();
    } catch (error) {
      setRecError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (recState !== "recording") return;
    const timer = setInterval(() => {
      setRecSeconds(recRef.current?.elapsedSeconds ?? 0);
    }, 200);
    return () => clearInterval(timer);
  }, [recState]);
  const audioDragRef = useRef<{
    clipId: string;
    mode: "move" | "resize" | "trimStart" | "trimEnd" | "fadeIn" | "fadeOut" | "gain";
    origStart: number;
    origLength: number;
    origTrimStart: number;
    origTrimEnd: number;
    origFadeIn: number;
    origFadeOut: number;
    origGain: number;
    grabBar: number;
    grabX: number;
    grabY: number;
  } | null>(null);
  const [audioDrag, setAudioDrag] = useState<{ startBar: number; lengthBars: number } | null>(null);
  const [audioFadePreview, setAudioFadePreview] = useState<{ clipId: string; fadeIn: number; fadeOut: number } | null>(
    null,
  );
  const [audioGainPreview, setAudioGainPreview] = useState<{ clipId: string; gain: number } | null>(null);
  const [audioMenu, setAudioMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);
  // Spectral Lab (RX-style clip surgery) — open from the AUDIO CLIP menu.
  const [spectralEditClipId, setSpectralEditClipId] = useState<string | null>(null);
  useEffect(() => {
    if (!audioMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".context-menu")) return;
      setAudioMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [audioMenu]);

  const clips = [...arrangement.clips].sort((a, b) => a.startBar - b.startBar);
  const audioClips = [...(arrangement.audioClips ?? [])].sort((a, b) => a.startBar - b.startBar);
  const totalBars = Math.max(
    16,
    ...clips.map((clip) => clip.startBar + clip.lengthBars + 4),
    ...audioClips.map((c) => c.startBar + c.lengthBars + 4),
  );
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedClip = clips.find((clip) => clip.id === selectedClipId);
  const selectedClipScene = selectedClip ? scenes.find((scene) => scene.id === selectedClip.sceneId) : undefined;
  const selectedClipBpm = effectiveSceneBpm(selectedClipScene?.bpm, doc.bpm);
  const selectedClipSeconds = selectedClip ? sceneBarsToSeconds(selectedClip.lengthBars, selectedClipBpm) : 0;
  const commitClipSecs = (): void => {
    if (!selectedClip || secsDraft === null) return;
    const seconds = Number.parseFloat(secsDraft);
    setSecsDraft(null);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const bars = Math.max(1, Math.round(sceneSecondsToBars(seconds, selectedClipBpm)));
    if (bars === selectedClip.lengthBars) return;
    execute(resizeArrangementClip(services.store.doc, selectedClip.id, bars));
  };
  const queuedScene = runtime.pendingPatternId
    ? scenes.find((scene) => scene.patternId === runtime.pendingPatternId)
    : undefined;
  const selectedTransition = transitionBoundary
    ? arrangement.transitions?.find(
        (transition) =>
          transition.fromClipId === transitionBoundary.fromClipId &&
          transition.toClipId === transitionBoundary.toClipId,
      )
    : undefined;

  const execute = (command: Parameters<typeof services.store.execute>[0]): boolean => {
    try {
      setActionError(null);
      services.store.execute(command);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Operation failed");
      return false;
    }
  };

  /**
   * Background transient detection for one buffer (worker when worthwhile,
   * sync fallback otherwise — see `detectTransientsAsync`). Idempotent:
   * cached and in-flight buffers are skipped.
   */
  const warmWarpOnsets = (bufferId: string): void => {
    if (warpOnsetCache.has(bufferId) || warpOnsetInflight.has(bufferId)) return;
    // Fire-and-forget: the shared promise caches the result for pins and dots.
    void getWarpOnsets(services.bank, bufferId);
  };

  /**
   * Add a warp pin at an absolute tick (neutral insertion: the pin lands on
   * the current warp map / straight playback, so the sound does not jump —
   * dragging it afterwards bends time). Time grabs the nearest detected
   * transient within 60 ms (transient magnet); the tick stays where the
   * user pointed. Shared by the context-menu action and double-click on
   * the waveform.
   */
  const addWarpPinAtTick = (clip: AudioClip, tick: number): void => {
    if (clip.reverse) {
      setActionError("Warp pins need forward playback — switch off Reverse first");
      return;
    }
    if (clip.loop) {
      setActionError("Warp is bypassed on looped clips — switch off Loop first");
      return;
    }
    const buf = services.bank.get(clip.bufferId);
    if (!buf) {
      setActionError("Buffer not loaded");
      return;
    }
    const clipStartTick = clip.startBar * BAR_TICKS;
    const clipTicks = clip.lengthBars * BAR_TICKS;
    const rel = tick - clipStartTick;
    if (!(rel > 0) || !(rel < clipTicks)) return;
    const spt = 60 / (doc.bpm * PPQ);
    const contentStart = (clip.offsetSec ?? 0) + (clip.trimStart ?? 0);
    const contentDur = Math.max(0.01, buf.duration - contentStart - (clip.trimEnd ?? 0));
    const contentEnd = contentStart + contentDur;
    const bufTime =
      warpBufferTimeAtTick({
        markers: clip.warpMarkers ?? [],
        clipStartTick,
        clipTicks,
        tick: Math.round(tick),
        spt,
        contentStartSec: contentStart,
        contentDurSec: contentDur,
        stretchRate: clip.stretchRate ?? 1,
        stretchMode: clip.stretchMode,
      }) ?? contentStart;
    // Transient magnet: grab the nearest onset when one is close, so pins
    // land on hits instead of between them. First placement warms the
    // detector and stays un-snapped; later placements snap.
    let finalTime = bufTime;
    const cached = warpOnsetCache.get(clip.bufferId);
    if (cached) {
      const snapped = nearestOnset(bufTime, cached, WARP_SNAP_SEC);
      if (snapped !== null) finalTime = Math.min(contentEnd, Math.max(contentStart, snapped));
    } else {
      warmWarpOnsets(clip.bufferId);
    }
    const markers = [
      ...(clip.warpMarkers ?? []),
      { timeSec: Math.round(finalTime * 1000) / 1000, tick: Math.round(tick) },
    ]
      .sort((a, b) => a.tick - b.tick)
      .slice(0, 256);
    try {
      execute(updateAudioClip(services.store.doc, clip.id, { warpMarkers: markers }));
      // Warm the pitch-preserving warp cache (stretch + pins) so
      // the next play is exact instead of repitch-fallback.
      services.engine.warmWarpForClip({ ...clip, warpMarkers: markers });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Warp pin failed");
    }
  };

  // Warm transient detection for every audio clip's buffer (magnet for
  // future pins). Keyed by buffer set — a project edit re-runs it, a
  // re-render does not.
  const warpBufferIds = audioClips.map((c) => c.bufferId).join(",");
  useEffect(() => {
    for (const c of audioClips) warmWarpOnsets(c.bufferId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warpBufferIds]);

  // Piecewise bar→seconds map (VISION §10): every clip's span runs at its
  // scene's EFFECTIVE tempo (scene.bpm pin, else project tempo), gaps at the
  // project tempo. Cumulative — bar N's wall-clock position accounts for the
  // tempo of everything before it, so SECS ruler labels stay honest.
  const barToSeconds = (bar: number): number => {
    const scenesById = new Map(scenes.map((scene) => [scene.id, scene]));
    let seconds = 0;
    let cursor = 0;
    for (const clip of clips) {
      const start = clip.startBar;
      const end = start + clip.lengthBars;
      if (bar <= start) break;
      const scene = scenesById.get(clip.sceneId);
      const bpm = effectiveSceneBpm(scene?.bpm, doc.bpm);
      const segEnd = Math.min(bar, end);
      if (segEnd > cursor) {
        seconds += sceneBarsToSeconds(segEnd - Math.max(cursor, start), bpm);
        cursor = segEnd;
      }
    }
    if (bar > cursor) seconds += sceneBarsToSeconds(bar - cursor, doc.bpm);
    return seconds;
  };

  const formatBarAsSeconds = (bar: number): string => `${barToSeconds(bar).toFixed(1)}s`;

  const barFromEvent = (event: React.PointerEvent | React.DragEvent): number => {
    const lane = laneRef.current;
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    return Math.max(0, Math.floor((event.clientX - rect.left) / barWidth));
  };

  const seekFromRulerEvent = (event: React.PointerEvent) => {
    const lane = laneRef.current;
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    const bar = Math.max(0, (event.clientX - rect.left) / barWidth);
    services.playback.seek(bar * BAR_TICKS);
  };
  void seekFromRulerEvent;

  const beginClipDrag = (event: React.PointerEvent, clipId: string, mode: "move" | "resize") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (!clip) return;
    setSelectedClipId(clipId);
    // Ctrl+click toggles the clip in the multi-selection (no drag).
    if (event.ctrlKey || event.metaKey) {
      const ids = selectionStore.isClipSelected(clipId)
        ? selection.clipIds.filter((id) => id !== clipId)
        : [...selection.clipIds, clipId];
      selectionStore.setClips(ids);
      return;
    }
    // Shift+click selects the range from the last selected clip.
    if (event.shiftKey) {
      const last = selection.clipIds.at(-1);
      const a = clips.findIndex((c) => c.id === last);
      const b = clips.findIndex((c) => c.id === clipId);
      selectionStore.setClips(
        a !== -1 && b !== -1 ? clips.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id) : [clipId],
      );
      return;
    }
    // Plain press on a clip inside an active multi-selection moves ALL
    // selected clips together (resize stays single-clip).
    if (mode === "move" && selection.clipIds.length > 1 && selectionStore.isClipSelected(clipId)) {
      const movingIds = selection.clipIds.filter((id) => clips.some((c) => c.id === id));
      const origStarts = Object.fromEntries(movingIds.map((id) => [id, clips.find((c) => c.id === id)!.startBar]));
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        mode,
        clipId,
        origStart: clip.startBar,
        origLength: clip.lengthBars,
        grabBar: barFromEvent(event),
        movingIds,
        origStarts,
      };
      setDrag({ startBar: clip.startBar, lengthBars: clip.lengthBars });
      setMultiDrag(0);
      return;
    }
    if (!selectionStore.isClipSelected(clipId)) selectionStore.setClips([clipId]);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      clipId,
      origStart: clip.startBar,
      origLength: clip.lengthBars,
      grabBar: barFromEvent(event),
    };
    setDrag({ startBar: clip.startBar, lengthBars: clip.lengthBars });
  };

  const onClipPointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current) return;
    const bar = barFromEvent(event);
    if (current.movingIds) {
      const delta = Math.max(bar - current.grabBar, -Math.min(...Object.values(current.origStarts ?? { 0: 0 })));
      setMultiDrag(delta);
      return;
    }
    if (current.mode === "move") {
      setDrag({ startBar: Math.max(0, current.origStart + bar - current.grabBar), lengthBars: current.origLength });
    } else {
      setDrag({ startBar: current.origStart, lengthBars: Math.max(1, bar - current.origStart + 1) });
    }
  };

  const onClipPointerUp = () => {
    const current = dragRef.current;
    const finalDrag = drag;
    const delta = multiDrag;
    dragRef.current = null;
    setDrag(null);
    setMultiDrag(null);
    if (!current || !finalDrag) return;
    if (current.movingIds) {
      if (!delta) return;
      // One gesture = one undo entry, regardless of how many clips moved.
      // The whole BLOCK moves to its final state at once: applying per-clip
      // `moveArrangementClip` would validate overlaps against INTERMEDIATE
      // states (moving adjacent clips by the same delta collides mid-way
      // even though the final layout is clean). Only stationary clips guard.
      const beforeDoc = services.store.doc;
      const target = (id: string) => Math.max(0, Math.round((current.origStarts?.[id] ?? 0) + delta));
      for (const id of current.movingIds) {
        const start = target(id);
        const length = beforeDoc.arrangement.clips.find((c) => c.id === id)?.lengthBars ?? 0;
        const collides = beforeDoc.arrangement.clips.some(
          (c) => !current.movingIds!.includes(c.id) && c.startBar < start + length && c.startBar + c.lengthBars > start,
        );
        if (collides) {
          setActionError("Clips would overlap — move cancelled");
          return;
        }
      }
      const nextDoc: ProjectDocument = {
        ...beforeDoc,
        arrangement: {
          ...beforeDoc.arrangement,
          clips: beforeDoc.arrangement.clips
            .map((c) => (current.movingIds!.includes(c.id) ? { ...c, startBar: target(c.id) } : c))
            .sort((a, b) => a.startBar - b.startBar),
        },
      };
      services.store.execute({
        type: "moveClips",
        label: `Move ${current.movingIds.length} clips`,
        execute: () => nextDoc,
        undo: () => beforeDoc,
      });
      return;
    }
    if (current.mode === "move" && finalDrag.startBar !== current.origStart) {
      execute(moveArrangementClip(services.store.doc, current.clipId, finalDrag.startBar));
    }
    if (current.mode === "resize" && finalDrag.lengthBars !== current.origLength) {
      execute(resizeArrangementClip(services.store.doc, current.clipId, finalDrag.lengthBars));
    }
  };

  // Interrupted clip drag — abort without moving/resizing.
  const onClipPointerCancel = () => {
    dragRef.current = null;
    setDrag(null);
    setMultiDrag(null);
  };

  /** Delete arrangement clips (single or multi) as ONE undoable gesture + toast. */
  const deleteClipsWithToast = (ids: string[]) => {
    if (ids.length === 0) return;
    const beforeDoc = services.store.doc;
    let nextDoc = beforeDoc;
    let firstName = "";
    for (const id of ids) {
      const clip = beforeDoc.arrangement.clips.find((c) => c.id === id);
      if (!clip) continue;
      const scene = scenes.find((sceneItem) => sceneItem.id === clip.sceneId);
      if (!firstName) firstName = scene?.name ?? "clip";
      nextDoc = deleteArrangementClip(nextDoc, id).execute(nextDoc);
    }
    if (nextDoc === beforeDoc) return;
    const label = ids.length === 1 ? `Deleted "${firstName}"` : `Deleted ${ids.length} clips`;
    services.store.execute({ type: "deleteClips", label, execute: () => nextDoc, undo: () => beforeDoc });
    if (selectedClipId && ids.includes(selectedClipId)) setSelectedClipId(null);
    setDeleteToast({ label });
  };

  const beginAudioDrag = (
    event: React.PointerEvent,
    clipId: string,
    mode: "move" | "resize" | "trimStart" | "trimEnd" | "fadeIn" | "fadeOut" | "gain",
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const clip = audioClips.find((c) => c.id === clipId);
    if (!clip) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedAudioClipId(clipId);
    setSelectedClipId(null);
    audioDragRef.current = {
      clipId,
      mode,
      origStart: clip.startBar,
      origLength: clip.lengthBars,
      origTrimStart: clip.trimStart ?? 0,
      origTrimEnd: clip.trimEnd ?? 0,
      origFadeIn: clip.fadeIn ?? 0,
      origFadeOut: clip.fadeOut ?? 0,
      origGain: clip.gain ?? 1,
      grabBar: barFromEvent(event),
      grabX: event.clientX,
      grabY: event.clientY,
    };
    if (mode === "fadeIn" || mode === "fadeOut")
      setAudioFadePreview({ clipId, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 });
    if (mode === "gain") setAudioGainPreview({ clipId, gain: clip.gain ?? 1 });
    setAudioDrag({ startBar: clip.startBar, lengthBars: clip.lengthBars });
  };
  const onAudioPointerMove = (event: React.PointerEvent) => {
    const cur = audioDragRef.current;
    if (!cur) return;
    const bar = barFromEvent(event);
    const delta = bar - cur.grabBar;
    const secPerBar = (BAR_TICKS * 60) / (doc.bpm * PPQ);
    if (cur.mode === "move") setAudioDrag({ startBar: Math.max(0, cur.origStart + delta), lengthBars: cur.origLength });
    else if (cur.mode === "resize")
      setAudioDrag({ startBar: cur.origStart, lengthBars: Math.max(0.25, cur.origLength + delta) });
    else if (cur.mode === "trimStart") {
      const newStart = Math.max(0, cur.origStart + delta);
      const newLen = Math.max(0.25, cur.origLength - delta);
      setAudioDrag({ startBar: newStart, lengthBars: newLen });
    } else if (cur.mode === "fadeIn") {
      const deltaSec = delta * secPerBar;
      const clipSec = cur.origLength * secPerBar;
      const maxFade = Math.min(2, clipSec * 0.5);
      const next = Math.max(0, Math.min(maxFade, cur.origFadeIn + deltaSec));
      setAudioFadePreview({ clipId: cur.clipId, fadeIn: next, fadeOut: cur.origFadeOut });
    } else if (cur.mode === "fadeOut") {
      const deltaSec = delta * secPerBar;
      const clipSec = cur.origLength * secPerBar;
      const maxFade = Math.min(2, clipSec * 0.5);
      const next = Math.max(0, Math.min(maxFade, cur.origFadeOut - deltaSec));
      setAudioFadePreview({ clipId: cur.clipId, fadeIn: cur.origFadeIn, fadeOut: next });
    } else if (cur.mode === "gain") {
      const deltaY = cur.grabY - event.clientY;
      const nextGain = Math.max(0, Math.min(2, cur.origGain + deltaY / 80));
      setAudioGainPreview({ clipId: cur.clipId, gain: nextGain });
    }
  };
  const onAudioPointerUp = (event?: React.PointerEvent) => {
    const cur = audioDragRef.current;
    const final = audioDrag;
    const fadePrev = audioFadePreview;
    const gainPrev = audioGainPreview;
    audioDragRef.current = null;
    setAudioDrag(null);
    setAudioFadePreview(null);
    setAudioGainPreview(null);
    if (!cur) return;
    if (cur.mode === "move" && final && final.startBar !== cur.origStart)
      execute(moveAudioClip(services.store.doc, cur.clipId, final.startBar));
    else if (cur.mode === "resize" && final && final.lengthBars !== cur.origLength)
      execute(resizeAudioClip(services.store.doc, cur.clipId, final.lengthBars));
    else if (cur.mode === "trimStart" && final) {
      const deltaSec = ((final.startBar - cur.origStart) * BAR_TICKS * 60) / (doc.bpm * PPQ);
      if (Math.abs(deltaSec) > 0.001)
        execute(
          updateAudioClip(services.store.doc, cur.clipId, {
            trimStart: Math.max(0, cur.origTrimStart + deltaSec),
            offsetSec: Math.max(0, (audioClips.find((c) => c.id === cur.clipId)?.offsetSec ?? 0) + deltaSec),
          }),
        );
      if (final.lengthBars !== cur.origLength)
        execute(resizeAudioClip(services.store.doc, cur.clipId, final.lengthBars));
    } else if (cur.mode === "fadeIn" && fadePrev && fadePrev.clipId === cur.clipId) {
      if (Math.abs(fadePrev.fadeIn - cur.origFadeIn) > 0.005)
        execute(updateAudioClip(services.store.doc, cur.clipId, { fadeIn: Math.round(fadePrev.fadeIn * 100) / 100 }));
    } else if (cur.mode === "fadeOut" && fadePrev && fadePrev.clipId === cur.clipId) {
      if (Math.abs(fadePrev.fadeOut - cur.origFadeOut) > 0.005)
        execute(updateAudioClip(services.store.doc, cur.clipId, { fadeOut: Math.round(fadePrev.fadeOut * 100) / 100 }));
    } else if (cur.mode === "gain" && gainPrev && gainPrev.clipId === cur.clipId) {
      if (Math.abs(gainPrev.gain - cur.origGain) > 0.01)
        execute(updateAudioClip(services.store.doc, cur.clipId, { gain: Math.round(gainPrev.gain * 100) / 100 }));
      void event;
    }
  };

  // Interrupted audio drag — abort; previews clear with the drag state.
  const onAudioPointerCancel = () => {
    audioDragRef.current = null;
    setAudioDrag(null);
    setAudioFadePreview(null);
    setAudioGainPreview(null);
  };
  const [bouncingZone, setBouncingZone] = useState(false);
  const bounceZoneToClip = async () => {
    if (!selection.timeRange || bouncingZone) return;
    const fromBar = selection.timeRange.fromTick / BAR_TICKS;
    const lenBars = (selection.timeRange.toTick - selection.timeRange.fromTick) / BAR_TICKS;
    if (lenBars < 0.25) return;
    const trackIds = selection.trackIds.length > 0 ? selection.trackIds : tracks.slice(0, 1).map((t) => t.id);
    setBouncingZone(true);
    try {
      // REAL bounce: offline-render the selected tracks (FX, groups, sends
      // included) for exactly the selected zone, then flip it to an audio
      // clip. No more placeholder sample standing in for the render.
      const zoneDoc = buildBounceZoneDoc(services.store.doc, trackIds, { startBar: fromBar, lengthBars: lenBars });
      const sr = services.engine.getLiveAudioContext()?.sampleRate ?? 44100;
      const buffer = await renderProject(zoneDoc, services.bank, { mode: "song", sampleRate: sr, tailSeconds: 2 });
      const bufferId = userSampleId(`bounce-${Math.round(fromBar)}b`);
      services.bank.add(bufferId, buffer);
      // Persist the WAV so the bounce survives reloads (bank is runtime-only).
      try {
        const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const detected = detectLoopBpm(buffer.getChannelData(0), buffer.sampleRate);
        await services.userSamples.save(
          {
            id: bufferId,
            name: `Bounce ${stamp}`,
            fileName: `${bufferId}.wav`,
            category: "Custom",
            duration: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            createdAt: new Date().toISOString(),
            ...(detected ? { bpm: detected.bpm } : {}),
          },
          encodeWav(buffer, 16),
        );
      } catch {
        /* persistence is best-effort — the take still plays this session */
      }
      if (
        !execute(addAudioClip(services.store.doc, trackIds[0], bufferId, fromBar, lenBars, { gain: 1, stretchRate: 1 }))
      ) {
        services.bank.remove(bufferId);
        try {
          await services.userSamples.remove(bufferId);
        } catch {
          /* best-effort cleanup */
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Bounce failed");
    } finally {
      setBouncingZone(false);
    }
  };

  const placeScene = (sceneId: string, bar: number, lengthBars = 4) => {
    execute(addArrangementClip(services.store.doc, sceneId, bar, lengthBars));
  };

  const appendBar = (): number => clips.reduce((max, clip) => Math.max(max, clip.startBar + clip.lengthBars), 0);

  const createRoleVariation = (role: "fill" | "drop" | "break") => {
    if (!selectedScene) return;
    const length = role === "fill" ? 1 : (selectedClip?.lengthBars ?? 4);
    execute(createVariationAndPlaceClip(services.store.doc, selectedScene.id, appendBar(), length, role));
  };

  const selectTransitionBoundary = (fromClipId: string, toClipId: string) => {
    const existing = arrangement.transitions?.find(
      (transition) => transition.fromClipId === fromClipId && transition.toClipId === toClipId,
    );
    setTransitionBoundary({ fromClipId, toClipId });
    setTransitionDraft({
      type: existing?.type ?? "custom",
      lengthBars: existing?.lengthBars ?? 1,
      cueAssetId: existing?.cueAssetId ?? "",
    });
  };

  const applyTransition = () => {
    if (!transitionBoundary) return;
    if (selectedTransition) {
      execute(updateArrangementTransition(services.store.doc, selectedTransition.id, transitionDraft));
    } else {
      execute(
        addArrangementTransition(
          services.store.doc,
          transitionBoundary.fromClipId,
          transitionBoundary.toClipId,
          transitionDraft.type,
          transitionDraft.lengthBars,
          transitionDraft.cueAssetId,
        ),
      );
    }
  };

  return (
    <section className="arr-panel" aria-label="Arrangement and scenes">
      <div className="arr-scenes">
        <div className="arr-scenes-header">
          <div className="arr-section-heading">
            <h2 className="panel-title">SCENES</h2>
            <span className="arr-section-label">SOURCE</span>
          </div>
          <button
            type="button"
            className="btn btn-small"
            title="Create scene from active pattern"
            onClick={() => execute(createScene(services.store.doc))}
          >
            + SCENE
          </button>
        </div>
        <div className="scene-actions">
          <button
            type="button"
            className="btn btn-small"
            disabled={!selectedScene}
            title="Give this scene an independent copy of its pattern — same scene, new editable pattern (the shared-pattern escape hatch)"
            onClick={() => selectedScene && execute(duplicatePatternForScene(services.store.doc, selectedScene.id))}
          >
            DUP PATTERN
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!selectedScene}
            title="Create a variation scene: new scene + varied copy of the pattern"
            onClick={() => selectedScene && execute(duplicateSceneAsVariation(services.store.doc, selectedScene.id))}
          >
            VARIATION
          </button>
        </div>
        <SceneLauncher
          variant="panel"
          playheadBar={playheadBar}
          selectedSceneId={selectedScene?.id}
          onSelectScene={(scene) => setSelectedSceneId(scene.id)}
          onRenameScene={(scene, name) => execute(renameScene(services.store.doc, scene.id, name))}
          onDeleteScene={(scene) => execute(deleteScene(services.store.doc, scene.id))}
          onReorderScenes={(fromIndex, toIndex) => execute(reorderScenes(services.store.doc, fromIndex, toIndex))}
          onDuplicatePattern={(scene) => execute(duplicatePatternForScene(services.store.doc, scene.id))}
        />
        {selectedScene && (
          <label className="arr-scene-role">
            ROLE
            <select
              value={selectedScene.role ?? sceneRoleOf(selectedScene) ?? ""}
              onChange={(event) =>
                execute(
                  setSceneRole(services.store.doc, selectedScene.id, (event.target.value || null) as SceneRole | null),
                )
              }
            >
              {SCENE_ROLES.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="arr-quick-actions">
          <button
            type="button"
            className="btn btn-small"
            disabled={!selectedScene}
            onClick={() => createRoleVariation("fill")}
          >
            FILL
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!selectedScene}
            onClick={() => createRoleVariation("drop")}
          >
            DROP
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!selectedScene}
            onClick={() => createRoleVariation("break")}
          >
            BREAK
          </button>
        </div>
      </div>

      <div className="arr-timeline">
        <div className="arr-timeline-header">
          <div className="arr-timeline-title-group">
            <h2 className="panel-title">ARRANGEMENT</h2>
            <div className="arr-status-strip" aria-live="polite">
              <span className="arr-status-badge arr-status-mode">{runtime.mode.toUpperCase()}</span>
              <span className="arr-status-badge arr-status-quantize">
                QUANTIZE <strong>1 BAR</strong>
              </span>
              {queuedScene ? (
                <span className="arr-status-badge arr-status-queued">
                  QUEUED <strong>{queuedScene.name}</strong> · NEXT BAR
                </span>
              ) : (
                <span className="arr-status-badge arr-status-ready">READY</span>
              )}
            </div>
          </div>
          <div className="arr-timeline-actions">
            <select
              className="arr-arm-select"
              aria-label="Arm track for recording"
              title="Arm a track — recorded mic takes land here as audio clips"
              value={armedTrackId}
              disabled={recState !== "idle"}
              onChange={(event) => setArmedTrackId(event.target.value)}
            >
              <option value="">ARM: pick track…</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </select>
            <select
              className="arr-arm-select"
              aria-label="Microphone input device"
              title="Choose the microphone or audio-interface input for recording. Names may be hidden until mic permission is granted."
              value={recordingInputDeviceId}
              disabled={recState !== "idle"}
              onChange={(event) => {
                const deviceId = event.target.value;
                setRecordingInputDeviceId(deviceId);
                saveRecordingInputDeviceId(deviceId);
              }}
            >
              <option value="">MIC: system default</option>
              {recordingInputDeviceId && !recordingInputDevices.some((device) => device.deviceId === recordingInputDeviceId) && (
                <option value={recordingInputDeviceId}>Saved microphone (not listed)</option>
              )}
              {recordingInputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`btn btn-small${micMonitoring ? " active-solo" : ""}`}
              aria-pressed={micMonitoring}
              title="Dry direct mic monitoring. Headphones recommended; speakers can cause feedback."
              onClick={() => {
                const next = !micMonitoring;
                setMicMonitoring(next);
                recRef.current?.setMonitoring(next);
              }}
            >
              {micMonitoring ? "DRY MON ON" : "DRY MON OFF"}
            </button>
            {recState === "recording" ? (
              <button type="button" className="btn btn-small btn-rec btn-rec-stop" onClick={() => void stopRec()}>
                ■ STOP {recSeconds.toFixed(0)}s
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-small btn-rec"
                title="Record the mic straight onto the armed track at the playhead (rolls the transport)"
                disabled={!armedTrackId || recState !== "idle"}
                onClick={() => void startRec()}
              >
                {recState === "starting" ? "◌ MIC…" : "● REC"}
              </button>
            )}
            {recState === "starting" && <span className="arr-rec-saving">opening microphone…</span>}
            {recState === "saving" && <span className="arr-rec-saving">placing clip…</span>}
            {recordingInputListError && (
              <span className="arr-rec-saving" role="status" aria-live="polite">
                mic list unavailable; system default remains usable
              </span>
            )}
            {recError && (
              <span className="arr-rec-error" role="alert">
                {recError}
              </span>
            )}
            <button
              type="button"
              className={`btn btn-small${rulerMode === "seconds" ? " active-solo" : ""}`}
              onClick={() => setRulerMode(rulerMode === "bars" ? "seconds" : "bars")}
            >
              {rulerMode === "bars" ? "BARS" : "SECS"}
            </button>
            <button
              type="button"
              className={`btn btn-small${showIntensity ? " active-solo" : ""}`}
              aria-pressed={showIntensity}
              title="Show the scene-intensity lane under the clip lane"
              onClick={() => setShowIntensity((value) => !value)}
            >
              INT
            </button>
            <span className="arr-zoom-group" role="group" aria-label="Arrangement zoom">
              <button
                type="button"
                className="btn btn-small"
                aria-label="Zoom out"
                onClick={() => setZoom((value) => Math.max(0.35, value / 1.4))}
              >
                −
              </button>
              <button
                type="button"
                className="btn btn-small"
                aria-label="Fit arrangement"
                title="Fit the whole arrangement into the view"
                onClick={() => {
                  const viewport = scrollRef.current?.clientWidth ?? 800;
                  setZoom(Math.max(0.35, Math.min(4, viewport / Math.max(1, totalBars * BASE_BAR_WIDTH))));
                  if (scrollRef.current) scrollRef.current.scrollLeft = 0;
                }}
              >
                FIT
              </button>
              <button
                type="button"
                className="btn btn-small"
                aria-label="Zoom in"
                onClick={() => setZoom((value) => Math.min(4, value * 1.4))}
              >
                +
              </button>
            </span>
            {selectedClip && (
              <label className="arr-clip-secs">
                SECS
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  aria-label="Clip length in seconds"
                  title={`${selectedClip.lengthBars} bars at ${Math.round(selectedClipBpm)} BPM — Enter resizes the clip`}
                  value={secsDraft ?? selectedClipSeconds.toFixed(2)}
                  onFocus={() => setSecsDraft(selectedClipSeconds.toFixed(2))}
                  onChange={(event) => setSecsDraft(event.target.value)}
                  onBlur={commitClipSecs}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitClipSecs();
                    if (event.key === "Escape") setSecsDraft(null);
                  }}
                />
              </label>
            )}
            <button
              type="button"
              className="btn btn-small"
              disabled={!selectedScene}
              onClick={() => selectedScene && placeScene(selectedScene.id, appendBar())}
            >
              + CLIP
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={!selectedClipId}
              onClick={() => selectedClipId && execute(duplicateArrangementClip(services.store.doc, selectedClipId))}
            >
              DUP
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={!selectedClipId}
              onClick={() => selectedClipId && execute(deleteArrangementClip(services.store.doc, selectedClipId))}
            >
              DEL
            </button>
            {!capture.capturing ? (
              <button type="button" className="btn btn-small" onClick={() => services.capture.start()}>
                CAPTURE
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-small active-solo"
                  onClick={() => {
                    try {
                      services.capture.finish();
                    } catch (error) {
                      setActionError(error instanceof Error ? error.message : "Capture failed");
                    }
                  }}
                >
                  FINISH {capture.launchCount}
                </button>
                <button type="button" className="btn btn-small btn-danger" onClick={() => services.capture.cancel()}>
                  CANCEL
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn-small"
              disabled={!selection.timeRange || bouncingZone}
              title="Bounce the selected zone (selected tracks, with FX/groups/sends) to an editable audio clip via an offline render. Shift the zone, hit bounce, flip it to a pad."
              onClick={() => void bounceZoneToClip()}
            >
              BOUNCE ZONE
            </button>
            {selectedAudioClipId && (
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => {
                  execute(deleteAudioClip(services.store.doc, selectedAudioClipId));
                  setSelectedAudioClipId(null);
                }}
              >
                DEL AUDIO
              </button>
            )}
            <button type="button" className="btn btn-small" onClick={() => setShowSkeletonPreview((value) => !value)}>
              BUILD SKELETON
            </button>
            <button
              type="button"
              className="btn btn-small btn-export"
              title="Lay all scenes into a song: intro → build → drop → break → drop → outro, with transitions and cue markers"
              onClick={() => {
                try {
                  execute(autoArrangeSong(services.store.doc));
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : "Auto-arrange failed");
                }
              }}
            >
              AUTO ARRANGE
            </button>
          </div>
        </div>

        {recoverableTakes.length > 0 && (
          <section className="arr-recording-recovery" aria-label="Recoverable vocal recordings">
            <strong>RECOVERABLE VOCAL TAKES</strong>
            {recoverableTakes.map((session) => {
              const canPlaceOnTimeline =
                session.placeOnTimeline !== false &&
                session.projectId === doc.id &&
                tracks.some((track) => track.id === session.trackId);
              return (
                <div className="arr-recording-recovery-row" key={session.id}>
                  <span>
                    {session.trackName} · {new Date(session.createdAt).toLocaleString()} ·{" "}
                    {(session.totalFrames / session.sampleRate).toFixed(1)}s
                    {session.status === "recording" && (
                      <span className="arr-rec-saving" role="status">
                        {" "}· interrupted capture; the final uncommitted audio may be incomplete
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={recoveringTakeId !== null || recState !== "idle"}
                    onClick={() => void recoverTake(session)}
                  >
                    {recoveringTakeId === session.id
                      ? "RECOVERING…"
                      : canPlaceOnTimeline
                        ? "RESTORE TO TIMELINE"
                        : "RECOVER TO SAMPLES"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={recoveringTakeId !== null || recState !== "idle"}
                    onClick={() => void discardTake(session)}
                  >
                    DISCARD
                  </button>
                </div>
              );
            })}
          </section>
        )}

        {showSkeletonPreview && (
          <div className="arr-skeleton-preview">
            <span className="arr-skeleton-title">
              {clips.length > 0 ? "REPLACE CURRENT ARRANGEMENT:" : "ARRANGEMENT PREVIEW:"}
            </span>
            {(() => {
              const roles = ["intro", "build", "drop", "break", "outro"] as const;
              const preview = roles.flatMap((role) => {
                const scene = scenes.find((candidate) => sceneRoleOf(candidate) === role);
                if (!scene) return [];
                return [
                  <span key={scene.id} className="arr-skeleton-item">
                    {role.toUpperCase()} {role === "drop" ? 16 : 8}B
                  </span>,
                ];
              });
              return preview.length > 0 ? preview : <span className="arr-skeleton-empty">No role scenes found</span>;
            })()}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                try {
                  execute(createArrangementSkeleton(services.store.doc));
                  setShowSkeletonPreview(false);
                } catch (error) {
                  setActionError(error instanceof Error ? error.message : "Cannot build skeleton");
                }
              }}
            >
              APPLY SKELETON
            </button>
          </div>
        )}

        <div className="arr-role-flow" aria-label="Arrangement role flow">
          {clips.length === 0 ? (
            <span className="arr-role-flow-empty">EMPTY ARRANGEMENT</span>
          ) : (
            clips.map((clip, index) => {
              const scene = scenes.find((candidate) => candidate.id === clip.sceneId);
              const role = scene ? (sceneRoleOf(scene) ?? "custom") : "custom";
              return (
                <span key={clip.id} className={`arr-role-flow-item role-${role}`}>
                  <span className="arr-role-flow-role">{role.toUpperCase()}</span>
                  <span className="arr-role-flow-length">{clip.lengthBars}B</span>
                  {index < clips.length - 1 && (
                    <span className="arr-role-flow-arrow" aria-hidden="true">
                      →
                    </span>
                  )}
                </span>
              );
            })
          )}
        </div>

        <div className="arr-lane-scroll" ref={scrollRef}>
          <div
            className="arr-ruler"
            style={{ width: totalBars * barWidth }}
            title="Click to seek · drag to select time range · shift+click adds a marker"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth);
              if (event.shiftKey) {
                execute(addMarker(services.store.doc, { tick: Math.floor(bar * BAR_TICKS), type: "cue" }));
                return;
              }
              setTimeDrag({ startBar: bar, currentBar: bar });
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!timeDrag) return;
              const bar = Math.max(
                0,
                Math.min(totalBars, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth),
              );
              setTimeDrag({ startBar: timeDrag.startBar, currentBar: bar });
              const from = Math.min(timeDrag.startBar, bar);
              const to = Math.max(timeDrag.startBar, bar);
              if (Math.abs(to - from) > 0.15) {
                selectionStore.setTimeRange({
                  fromTick: Math.floor(from * BAR_TICKS),
                  toTick: Math.floor(to * BAR_TICKS),
                });
              } else {
                selectionStore.setTimeRange(null);
              }
            }}
            onPointerUp={(event) => {
              if (!timeDrag) return;
              const from = Math.min(timeDrag.startBar, timeDrag.currentBar);
              const to = Math.max(timeDrag.startBar, timeDrag.currentBar);
              if (Math.abs(to - from) < 0.15) {
                services.playback.seek(Math.floor(from * BAR_TICKS));
                selectionStore.setTimeRange(null);
              }
              setTimeDrag(null);
              try {
                (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
              } catch {
                /* pointer already gone (cancelled) */
              }
            }}
            onPointerCancel={() => {
              // Interrupted drag — drop the in-progress range selection.
              setTimeDrag(null);
              selectionStore.setTimeRange(null);
            }}
            onPointerLeave={() => {
              // keep drag active, don't clear
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              const x = event.clientX - laneRef.current!.getBoundingClientRect().left;
              const closest = markers
                .map((marker) => ({ id: marker.id, dist: Math.abs((marker.tick / BAR_TICKS) * barWidth - x) }))
                .filter((marker) => marker.dist < 8)
                .sort((a, b) => a.dist - b.dist)[0];
              if (closest) execute(removeMarker(services.store.doc, closest.id));
            }}
          >
            {Array.from({ length: Math.ceil(totalBars / 4) }, (_, index) => {
              const barNum = index * 4 + 1;
              return (
                <span key={index} className="arr-ruler-mark" style={{ left: index * 4 * barWidth }}>
                  {rulerMode === "seconds" ? formatBarAsSeconds(barNum - 1) : barNum}
                </span>
              );
            })}
            {markers.map((marker) => (
              <div
                key={marker.id}
                className={`arr-marker arr-marker-${marker.type}`}
                style={{ left: (marker.tick / BAR_TICKS) * barWidth - 6 }}
                title={`${marker.name} (${marker.type})`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  execute(removeMarker(services.store.doc, marker.id));
                }}
              />
            ))}
            {selection.timeRange && (
              <div
                className="arr-time-range"
                style={{
                  left: (Math.min(selection.timeRange.fromTick, selection.timeRange.toTick) / BAR_TICKS) * barWidth,
                  width: (Math.abs(selection.timeRange.toTick - selection.timeRange.fromTick) / BAR_TICKS) * barWidth,
                }}
              />
            )}
            <div className="arr-playhead" style={{ left: playheadBar * barWidth }} />
          </div>
          <div
            className="arr-lane"
            ref={laneRef}
            style={{ width: totalBars * barWidth, height: LANE_HEIGHT }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              // FL: Ctrl+drag on lane → range select (Cubase Range Tool)
              if ((event.ctrlKey || event.metaKey) && event.target === laneRef.current) {
                const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth);
                setTimeDrag({ startBar: bar, currentBar: bar });
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                event.preventDefault();
                return;
              }
              if (event.target !== laneRef.current) return;
              // Empty-lane drag = marquee-select clips. A plain click still
              // places the selected scene (handled at pointerup).
              const bar = barFromEvent(event);
              marqueeStartRef.current = bar;
              setMarquee({ from: bar, to: bar });
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (marqueeStartRef.current !== null) {
                const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth);
                setMarquee({ from: marqueeStartRef.current, to: bar });
                return;
              }
              if (!timeDrag) return;
              // Only handle lane Ctrl+drag here; ruler has its own handler
              if (!(event.ctrlKey || event.metaKey) && event.buttons === 1) {
                // If we started via lane Ctrl+drag, keep updating even if Ctrl released
              }
              const bar = Math.max(
                0,
                Math.min(totalBars, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth),
              );
              setTimeDrag({ startBar: timeDrag.startBar, currentBar: bar });
              const from = Math.min(timeDrag.startBar, bar);
              const to = Math.max(timeDrag.startBar, bar);
              if (Math.abs(to - from) > 0.15)
                selectionStore.setTimeRange({
                  fromTick: Math.floor(from * BAR_TICKS),
                  toTick: Math.floor(to * BAR_TICKS),
                });
              else selectionStore.setTimeRange(null);
            }}
            onPointerUp={(event) => {
              if (marqueeStartRef.current !== null) {
                const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / barWidth);
                const from = Math.min(marqueeStartRef.current, bar);
                const to = Math.max(marqueeStartRef.current, bar);
                marqueeStartRef.current = null;
                setMarquee(null);
                try {
                  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
                } catch {
                  /* pointer already gone */
                }
                if (to - from < 0.15) {
                  // Plain click on empty lane: place the selected scene.
                  if (selectedScene) placeScene(selectedScene.id, from);
                  selectionStore.setClips([]);
                  setSelectedClipId(null);
                } else {
                  selectionStore.setClips(
                    clips.filter((c) => c.startBar < to && c.startBar + c.lengthBars > from).map((c) => c.id),
                  );
                  setSelectedClipId(null);
                }
                return;
              }
              if (!timeDrag) return;
              const from = Math.min(timeDrag.startBar, timeDrag.currentBar);
              const to = Math.max(timeDrag.startBar, timeDrag.currentBar);
              if (Math.abs(to - from) < 0.15 && !(event.ctrlKey || event.metaKey)) {
                // Small drag without Ctrl was actually a click → place already handled
                selectionStore.setTimeRange(null);
              }
              setTimeDrag(null);
              try {
                (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
              } catch {
                /* pointer already gone (cancelled) */
              }
            }}
            onPointerCancel={() => {
              marqueeStartRef.current = null;
              setMarquee(null);
              setTimeDrag(null);
              selectionStore.setTimeRange(null);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const sceneId = event.dataTransfer.getData("application/x-pulse-forge-scene");
              if (sceneId) placeScene(sceneId, barFromEvent(event));
            }}
          >
            <div className="arr-playhead arr-playhead-lane" style={{ left: playheadBar * barWidth }} />
            {selection.timeRange && (
              <div
                className="arr-time-range arr-time-range-lane"
                style={{
                  left: (Math.min(selection.timeRange.fromTick, selection.timeRange.toTick) / BAR_TICKS) * barWidth,
                  width: (Math.abs(selection.timeRange.toTick - selection.timeRange.fromTick) / BAR_TICKS) * barWidth,
                }}
              />
            )}
            {marquee && (
              <div
                className="arr-marquee"
                style={{
                  left: Math.min(marquee.from, marquee.to) * barWidth,
                  width: Math.abs(marquee.to - marquee.from) * barWidth,
                }}
              />
            )}
            {Array.from({ length: totalBars }, (_, index) => (
              <div
                key={index}
                className={`arr-bar-grid${index % 4 === 0 ? " bar-strong" : ""}`}
                style={{ left: index * barWidth }}
              />
            ))}
            {clips.map((clip, index) => {
              const scene = scenes.find((candidate) => candidate.id === clip.sceneId);
              const role = scene ? (sceneRoleOf(scene) ?? "custom") : "custom";
              const isDragging = dragRef.current?.clipId === clip.id && drag !== null;
              const multiMoving = dragRef.current?.movingIds?.includes(clip.id) && multiDrag !== null;
              const startBar = multiMoving ? clip.startBar + multiDrag : isDragging ? drag.startBar : clip.startBar;
              const lengthBars = isDragging ? drag.lengthBars : clip.lengthBars;
              const nextClip = clips[index + 1];
              const selected = selectedClipId === clip.id || selectionStore.isClipSelected(clip.id);
              const isCurrentClip = playheadBar >= clip.startBar && playheadBar < clip.startBar + clip.lengthBars;
              return (
                <div key={clip.id}>
                  <div
                    className={`arr-clip role-${role}${selected ? " selected" : ""}${isCurrentClip ? " current" : ""}${runtime.playing && isCurrentClip ? " playing" : ""}`}
                    style={{ left: startBar * barWidth, width: lengthBars * barWidth - 4 }}
                    title={`${scene?.name ?? "?"} · ${role.toUpperCase()} · bars ${startBar + 1}–${startBar + lengthBars}`}
                    onPointerDown={(event) =>
                      beginClipDrag(
                        event,
                        clip.id,
                        event.clientX > event.currentTarget.getBoundingClientRect().right - 10 ? "resize" : "move",
                      )
                    }
                    onPointerMove={onClipPointerMove}
                    onPointerUp={onClipPointerUp}
                    onPointerCancel={onClipPointerCancel}
                    onClick={() => setSelectedClipId(clip.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      // Right-click deletes the whole active selection (or the
                      // clicked clip) as one undoable gesture + toast with UNDO.
                      const ids = selectionStore.isClipSelected(clip.id) ? [...selection.clipIds] : [clip.id];
                      deleteClipsWithToast(ids);
                    }}
                  >
                    <span className="arr-clip-copy">
                      <span className="arr-clip-role">{role.toUpperCase()}</span>
                      <span className="arr-clip-name">{scene?.name ?? "?"}</span>
                    </span>
                    <span className="arr-clip-bars">{lengthBars}b</span>
                    <span className="arr-clip-resize" />
                  </div>
                  {nextClip && (
                    <button
                      type="button"
                      className={`arr-transition-mark${transitionBoundary?.fromClipId === clip.id && transitionBoundary.toClipId === nextClip.id ? " selected" : ""}`}
                      style={{ left: (clip.startBar + clip.lengthBars) * barWidth - 8 }}
                      title="Edit transition to next clip"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => selectTransitionBoundary(clip.id, nextClip.id)}
                    >
                      {arrangement.transitions?.some(
                        (transition) => transition.fromClipId === clip.id && transition.toClipId === nextClip.id,
                      )
                        ? "TR"
                        : "+"}
                    </button>
                  )}
                </div>
              );
            })}
            {audioClips.map((clip) => {
              const isDragging = audioDragRef.current?.clipId === clip.id && audioDrag !== null;
              const startBar = isDragging ? audioDrag.startBar : clip.startBar;
              const lengthBars = isDragging ? audioDrag.lengthBars : clip.lengthBars;
              const selected = selectedAudioClipId === clip.id;
              const isCurrent = playheadBar >= clip.startBar && playheadBar < clip.startBar + clip.lengthBars;
              const track = tracks.find((t) => t.id === clip.trackId);
              const buffer = services.bank.get(clip.bufferId);
              const effFadeIn = audioFadePreview?.clipId === clip.id ? audioFadePreview.fadeIn : (clip.fadeIn ?? 0);
              const effFadeOut = audioFadePreview?.clipId === clip.id ? audioFadePreview.fadeOut : (clip.fadeOut ?? 0);
              const effGain = audioGainPreview?.clipId === clip.id ? audioGainPreview.gain : (clip.gain ?? 1);
              return (
                <div
                  key={clip.id}
                  className={`arr-audio-clip${selected ? " selected" : ""}${isCurrent ? " current" : ""}`}
                  style={{ left: startBar * barWidth, width: lengthBars * barWidth - 4 }}
                  title={`${track?.name ?? clip.trackId} · ${clip.bufferId} · ${clip.reverse ? "REV " : ""}${clip.loop ? "LOOP " : ""}${(clip.warpMarkers?.length ?? 0) > 0 ? `WARP${clip.warpMarkers!.length} ` : ""}${clip.stretchMode === "stretch" ? `STRETCH×${clip.stretchRate.toFixed(2)} ` : clip.stretchRate !== 1 ? `×${clip.stretchRate.toFixed(2)} ` : ""}${lengthBars}b · trim ${clip.trimStart.toFixed(2)}/${clip.trimEnd.toFixed(2)} fade ${effFadeIn.toFixed(2)}/${effFadeOut.toFixed(2)} gain ${effGain.toFixed(2)} — PT: top corners fade, top middle clip gain`}
                  onPointerDown={(event) => {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const x = event.clientX - rect.left;
                    const w = rect.width;
                    if (x < 8) beginAudioDrag(event, clip.id, "trimStart");
                    else if (x > w - 8) beginAudioDrag(event, clip.id, "resize");
                    else beginAudioDrag(event, clip.id, "move");
                  }}
                  onPointerMove={onAudioPointerMove}
                  onPointerUp={onAudioPointerUp}
                  onPointerCancel={onAudioPointerCancel}
                  onClick={() => {
                    setSelectedAudioClipId(clip.id);
                    setSelectedClipId(null);
                  }}
                  onDoubleClick={(event) => {
                    // Double-click empty waveform = add a neutral warp pin.
                    // Pin handles / trim / fade / gain zones keep their own
                    // gestures — only the bare waveform adds pins.
                    const target = event.target as HTMLElement | null;
                    if (
                      target?.closest(
                        ".warp-pin, .arr-audio-clip-handle, .arr-audio-clip-handle-fade, .arr-audio-clip-handle-gain",
                      )
                    )
                      return;
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    if (rect.width <= 0) return;
                    const frac = (event.clientX - rect.left) / rect.width;
                    addWarpPinAtTick(clip, Math.round(clip.startBar * BAR_TICKS + frac * clip.lengthBars * BAR_TICKS));
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setAudioMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <AudioClipWaveform
                    buffer={buffer ?? null}
                    bufferId={clip.bufferId}
                    reverse={clip.reverse}
                    showOnsets={selected || (clip.warpMarkers?.length ?? 0) > 0}
                  />
                  <WarpPinsOverlay
                    clip={clip}
                    disabledReason={
                      clip.reverse
                        ? "Warp needs forward playback — switch off Reverse"
                        : clip.loop
                          ? "Warp is bypassed on looped clips — switch off Loop"
                          : null
                    }
                    onCommit={(markers) => {
                      try {
                        execute(updateAudioClip(services.store.doc, clip.id, { warpMarkers: markers }));
                        services.engine.warmWarpForClip({ ...clip, warpMarkers: markers });
                      } catch (err) {
                        setActionError(err instanceof Error ? err.message : "Warp edit failed");
                      }
                    }}
                  />
                  <span className="arr-audio-clip-label">{track?.name ?? clip.bufferId.slice(0, 8)}</span>
                  <span
                    className="arr-audio-clip-handle left"
                    title="Trim start"
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "trimStart")}
                  />
                  <span
                    className="arr-audio-clip-handle right"
                    title="Resize / trim end"
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "resize")}
                  />
                  <span
                    className="arr-audio-clip-handle-fade left"
                    title={`Fade in ${effFadeIn.toFixed(2)}s — drag horizontal (PT top corner)`}
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "fadeIn")}
                  />
                  <span
                    className="arr-audio-clip-handle-fade right"
                    title={`Fade out ${effFadeOut.toFixed(2)}s — drag horizontal`}
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "fadeOut")}
                  />
                  <span
                    className="arr-audio-clip-handle-gain"
                    title={`Clip gain ${effGain.toFixed(2)} (${(20 * Math.log10(Math.max(effGain, 0.001))).toFixed(1)} dB) — drag vertical (PT top middle)`}
                    onPointerDown={(e) => beginAudioDrag(e, clip.id, "gain")}
                  />
                  {selected && (
                    <div className="arr-audio-clip-fades">
                      <span
                        className="arr-audio-fade in"
                        style={{
                          width: Math.min(
                            24,
                            (effFadeIn / ((clip.lengthBars * BAR_TICKS * 60) / (doc.bpm * PPQ))) *
                              lengthBars *
                              barWidth,
                          ),
                        }}
                      />
                      <span
                        className="arr-audio-fade out"
                        style={{
                          width: Math.min(
                            24,
                            (effFadeOut / ((clip.lengthBars * BAR_TICKS * 60) / (doc.bpm * PPQ))) *
                              lengthBars *
                              barWidth,
                          ),
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {showIntensity && (
              <IntensityLane
                scenes={scenes}
                clips={clips}
                totalBars={totalBars}
                playheadBar={playheadBar}
                barWidth={barWidth}
                onEdit={(sceneId, curve) => execute(setSceneIntensityCurve(services.store.doc, sceneId, curve))}
              />
            )}
          </div>
        </div>

        {deleteToast && (
          <div className="arr-delete-toast" role="status">
            <span>{deleteToast.label}</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                services.store.undo();
                setDeleteToast(null);
              }}
            >
              UNDO
            </button>
          </div>
        )}

        {transitionBoundary && (
          <div className="arr-transition-editor">
            <span className="arr-transition-label">
              TRANSITION{" "}
              {scenes.find(
                (scene) => scene.id === clips.find((clip) => clip.id === transitionBoundary.fromClipId)?.sceneId,
              )?.name ?? "?"}{" "}
              →{" "}
              {scenes.find(
                (scene) => scene.id === clips.find((clip) => clip.id === transitionBoundary.toClipId)?.sceneId,
              )?.name ?? "?"}
            </span>
            <select
              value={transitionDraft.type}
              onChange={(event) =>
                setTransitionDraft((draftValue) => ({
                  ...draftValue,
                  type: event.target.value as ArrangementTransitionType,
                }))
              }
            >
              {TRANSITION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.toUpperCase()}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={4}
              step={1}
              value={transitionDraft.lengthBars}
              aria-label="Transition length in bars"
              onChange={(event) =>
                setTransitionDraft((draftValue) => ({
                  ...draftValue,
                  lengthBars: Math.min(4, Math.max(1, Number(event.target.value) || 1)),
                }))
              }
            />
            <input
              value={transitionDraft.cueAssetId}
              placeholder="cue asset (optional)"
              aria-label="Transition cue asset"
              onChange={(event) =>
                setTransitionDraft((draftValue) => ({ ...draftValue, cueAssetId: event.target.value }))
              }
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!transitionDraft.cueAssetId.trim()}
              onClick={() => services.engine.previewAsset(transitionDraft.cueAssetId.trim())}
            >
              PREVIEW CUE
            </button>
            <button type="button" className="btn btn-small" onClick={applyTransition}>
              {selectedTransition ? "UPDATE" : "ADD"}
            </button>
            {selectedTransition && (
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => {
                  execute(removeArrangementTransition(services.store.doc, selectedTransition.id));
                  setTransitionBoundary(null);
                }}
              >
                DELETE
              </button>
            )}
          </div>
        )}
        {audioMenu && (
          <div
            className="context-menu"
            role="menu"
            style={{ left: audioMenu.x, top: audioMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="context-menu-header">AUDIO CLIP</div>
            <button
              type="button"
              role="menuitem"
              title="RX-style spectral surgery — select a time×frequency region and attenuate or boost it"
              onClick={() => {
                setSpectralEditClipId(audioMenu.clipId);
                setAudioMenu(null);
              }}
            >
              Spectral Edit…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (c) execute(updateAudioClip(services.store.doc, c.id, { reverse: !c.reverse }));
                setAudioMenu(null);
              }}
            >
              Reverse ({audioClips.find((x) => x.id === audioMenu.clipId)?.reverse ? "ON" : "OFF"})
            </button>
            <button
              type="button"
              role="menuitem"
              title="Loop the trimmed content for the whole clip length — texture beds across N bars without duplicating clips"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (c) execute(updateAudioClip(services.store.doc, c.id, { loop: !c.loop }));
                setAudioMenu(null);
              }}
            >
              Loop ({audioClips.find((x) => x.id === audioMenu.clipId)?.loop ? "ON" : "OFF"})
            </button>
            <button
              type="button"
              role="menuitem"
              title="Pin the sample time playing at the playhead to the grid — grabs the nearest transient within 60 ms. Resample clips bend pitch (repitch warp), Stretch clips keep pitch (phase-vocoder pre-render, warmed in background)"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                const pos = services.transport.position;
                const clipStartTick = c.startBar * BAR_TICKS;
                const clipTicks = c.lengthBars * BAR_TICKS;
                if (!(pos > clipStartTick) || !(pos < clipStartTick + clipTicks)) {
                  setActionError("Move playhead inside the clip, then pin");
                  setAudioMenu(null);
                  return;
                }
                addWarpPinAtTick(c, pos);
                setAudioMenu(null);
              }}
            >
              Warp pin at playhead ({(audioClips.find((x) => x.id === audioMenu.clipId)?.warpMarkers ?? []).length})
            </button>
            {(audioClips.find((x) => x.id === audioMenu.clipId)?.warpMarkers ?? []).length > 0 && (
              <button
                type="button"
                role="menuitem"
                title="Remove all warp pins — back to straight playback"
                onClick={() => {
                  const c = audioClips.find((x) => x.id === audioMenu.clipId);
                  if (c) {
                    try {
                      execute(updateAudioClip(services.store.doc, c.id, { warpMarkers: [] }));
                    } catch (err) {
                      setActionError(err instanceof Error ? err.message : "Clear warp failed");
                    }
                  }
                  setAudioMenu(null);
                }}
              >
                Clear warp pins
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                if (c && buf) {
                  let max = 0;
                  const ch = buf.getChannelData(0);
                  for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i]));
                  const gain = max > 0.001 ? Math.min(2, 0.99 / max) : 1;
                  execute(updateAudioClip(services.store.doc, c.id, { gain }));
                }
                setAudioMenu(null);
              }}
            >
              Normalize (gain→0.99 peak)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                const detected = buf ? detectLoopBpm(buf.getChannelData(0), buf.sampleRate) : null;
                if (c && detected) {
                  try {
                    execute(fitAudioClipTempo(services.store.doc, c.id, detected.bpm));
                  } catch (err) {
                    setActionError(err instanceof Error ? err.message : "Fit failed");
                  }
                } else {
                  setActionError("No steady tempo detected in this sample");
                }
                setAudioMenu(null);
              }}
              title="Detect the loop's tempo and pitch-preserving time-stretch it to the project BPM"
            >
              Fit to project BPM ({doc.bpm})
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                const pattern = patterns.find((p) => p.id === activePatternId);
                if (!buf || !c || !pattern) {
                  setActionError("Loop not loaded");
                  setAudioMenu(null);
                  return;
                }
                // The groove lives in the loop's OWN tempo — use the detected
                // one (falling back to the project tempo for steady loops).
                const bpm = detectLoopBpm(buf.getChannelData(0), buf.sampleRate)?.bpm ?? doc.bpm;
                const map = extractGroove(buf.getChannelData(0), buf.sampleRate, bpm, pattern.stepCount);
                if (!map) {
                  setActionError("No groove found — need a rhythmic loop");
                  setAudioMenu(null);
                  return;
                }
                // Auto-save to the groove pool — reusable on any pattern later.
                void services.groovePool
                  .save({
                    id: `groove-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
                    name: `Groove ${Math.round(bpm)} BPM`,
                    timing: map.timing,
                    accent: map.accent,
                    createdAt: new Date().toISOString(),
                  })
                  .catch(() => {});
                try {
                  execute(stealGrooveIntoPattern(doc, pattern.id, map, { applyVelocity: true }));
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : "Steal groove failed");
                }
                setAudioMenu(null);
              }}
              title="Extract the loop's timing feel and accents onto the active pattern's existing steps"
            >
              Steal groove → active pattern
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const buf = c ? services.bank.get(c.bufferId) : null;
                if (!buf || !c) {
                  setActionError("Loop not loaded");
                  setAudioMenu(null);
                  return;
                }
                const analysis = analyzeLoopForFlip(buf.getChannelData(0), buf.sampleRate);
                if (!analysis) {
                  setActionError("Could not analyse the loop — no steady groove found");
                  setAudioMenu(null);
                  return;
                }
                const genre = (window.prompt("AI FLIP — genre (house / techno / trap / ambient):", "house") ?? "")
                  .trim()
                  .toLowerCase();
                const safeGenre = (["house", "techno", "trap", "ambient"] as const).includes(
                  genre as "house" | "techno" | "trap" | "ambient",
                )
                  ? (genre as "house" | "techno" | "trap" | "ambient")
                  : "house";
                try {
                  execute(
                    generatePatternCommand(
                      services.store.doc,
                      buildFlipOptions(analysis, safeGenre, flipSeed(analysis)),
                      `Flip ${c.startBar}b`,
                    ),
                  );
                  // The generated pattern is now active — bake the loop's groove on top.
                  execute(
                    stealGrooveIntoPattern(services.store.doc, activePatternId, analysis.groove, {
                      applyVelocity: true,
                    }),
                  );
                } catch (err) {
                  setActionError(err instanceof Error ? err.message : "AI Flip failed");
                }
                setAudioMenu(null);
              }}
              title="Generate a fresh pattern from this loop's feel — your BPM, your key, its groove. Lands as a new scene."
            >
              AI FLIP → new scene
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                const currentRate = c?.stretchRate ?? 1;
                const currentMode = c?.stretchMode ?? "resample";
                const modeLabel = currentMode === "stretch" ? "preserve pitch" : "pitch+time";
                const v = window.prompt(
                  `Stretch rate 0.25–4 (1=normal, 0.5=half speed)\nMode: ${modeLabel} (type "preserve" for pitch-preserving stretch, or just the rate)`,
                  String(currentRate),
                );
                if (v === null) {
                  setAudioMenu(null);
                  return;
                }
                const isPreserve = v.toLowerCase().includes("preserve");
                const rate = Number(isPreserve ? v.replace(/preserve/i, "").trim() || currentRate : v);
                if (Number.isFinite(rate) && rate >= 0.25 && rate <= 4) {
                  execute(
                    updateAudioClip(services.store.doc, audioMenu.clipId, {
                      stretchRate: Math.round(rate * 100) / 100,
                      stretchMode: isPreserve ? "stretch" : "resample",
                    }),
                  );
                }
                setAudioMenu(null);
              }}
            >
              Time-stretch…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                setAudioMenu(null);
                const buf = services.bank.get(c.bufferId);
                if (!buf) {
                  setActionError("Buffer not loaded");
                  setAudioMenu(null);
                  return;
                }
                sliceAnalysisRef.current?.abort();
                const controller = new AbortController();
                sliceAnalysisRef.current = controller;
                // Long sample analysis runs in the onset worker so slicing
                // cannot freeze the arrangement/timeline interaction.
                try {
                  const times = await detectTransientsAsync(
                    buf.getChannelData(0),
                    buf.sampleRate,
                    1,
                    controller.signal,
                  );
                  if (controller.signal.aborted) return;
                  const currentDoc = services.store.doc;
                  const currentClip = (currentDoc.arrangement.audioClips ?? []).find((clip) => clip.id === c.id);
                  if (
                    !currentClip ||
                    currentClip.bufferId !== c.bufferId ||
                    services.bank.get(currentClip.bufferId) !== buf
                  )
                    return;
                  const slices: Array<{ start: number; end: number }> = [];
                  for (let i = 0; i < Math.min(16, times.length + 1); i++) {
                    const start = i === 0 ? 0 : times[i - 1];
                    const end = i < times.length ? times[i] : buf.duration;
                    if (end - start > 0.02) slices.push({ start, end });
                  }
                  if (slices.length === 0) slices.push({ start: 0, end: buf.duration });
                  const drumTrack = currentDoc.tracks.find((t) => t.kind === "drum");
                  if (!drumTrack) {
                    setActionError("No drum track");
                  } else {
                    // Store bounced buffer as temp asset then slice
                    const bounceId = `stem-${c.id}`;
                    services.bank.add(bounceId, buf);
                    execute(sliceToPads(currentDoc, drumTrack.id, bounceId, slices, "Slice"));
                  }
                } catch (error) {
                  if (!controller.signal.aborted) setActionError(String(error));
                } finally {
                  if (sliceAnalysisRef.current === controller) sliceAnalysisRef.current = null;
                }
              }}
            >
              Slice to pads (onset)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const pos = services.transport.position;
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                const s = c.startBar * BAR_TICKS;
                const e = s + c.lengthBars * BAR_TICKS;
                if (pos <= s || pos >= e) {
                  setActionError("Move playhead inside clip then Ctrl+E");
                  setAudioMenu(null);
                  return;
                }
                try {
                  execute(splitAudioClipAtTick(services.store.doc, c.id, pos));
                } catch (err) {
                  setActionError(String(err));
                }
                setAudioMenu(null);
              }}
            >
              Separate at playhead (Ctrl+E)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (!c) {
                  setAudioMenu(null);
                  return;
                }
                const buf = services.bank.get(c.bufferId);
                if (!buf) {
                  setActionError("Buffer not loaded");
                  setAudioMenu(null);
                  return;
                }
                const data = buf.getChannelData(0);
                const win = 1024,
                  hop = 256,
                  thresh = 0.015;
                const frames = Math.floor((data.length - win) / hop) + 1;
                const env = new Float64Array(frames);
                for (let f = 0; f < frames; f++) {
                  let s = 0;
                  for (let i = f * hop; i < f * hop + win; i++) s += data[i] * data[i];
                  env[f] = Math.sqrt(s / win);
                }
                const segments: Array<{ startSec: number; endSec: number }> = [];
                let inSeg = false,
                  segStart = 0;
                for (let f = 0; f < frames; f++) {
                  const sec = (f * hop) / buf.sampleRate;
                  const isSilent = env[f] < thresh;
                  if (!isSilent && !inSeg) {
                    inSeg = true;
                    segStart = sec;
                  } else if (isSilent && inSeg) {
                    // require 0.08s silence to close
                    let silentFrames = 0;
                    for (let k = f; k < Math.min(frames, f + 8); k++) if (env[k] < thresh) silentFrames++;
                    if (silentFrames >= 6) {
                      segments.push({ startSec: segStart, endSec: sec });
                      inSeg = false;
                    }
                  }
                }
                if (inSeg) segments.push({ startSec: segStart, endSec: buf.duration });
                const filtered = segments.filter((s) => s.endSec - s.startSec > 0.06);
                if (filtered.length === 0) {
                  setActionError("No silence found");
                  setAudioMenu(null);
                  return;
                }
                if (filtered.length === 1 && Math.abs(filtered[0].startSec - (c.offsetSec ?? 0)) < 0.01) {
                  setActionError("Already stripped");
                  setAudioMenu(null);
                  return;
                }
                try {
                  execute(stripSilenceAudioClip(services.store.doc, c.id, filtered));
                } catch (err) {
                  setActionError(String(err));
                }
                setAudioMenu(null);
              }}
            >
              Strip Silence (PT)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const sel = selection.timeRange;
                if (sel) {
                  const from = sel.fromTick,
                    to = sel.toTick;
                  const ids = (arrangement.audioClips ?? [])
                    .filter((ac) => {
                      const s = ac.startBar * BAR_TICKS,
                        e = s + ac.lengthBars * BAR_TICKS;
                      return s >= from && e <= to;
                    })
                    .map((ac) => ac.id);
                  if (ids.length < 2) {
                    setActionError("Select timeRange with ≥2 clips to consolidate");
                    setAudioMenu(null);
                    return;
                  }
                  try {
                    execute(consolidateAudioClips(services.store.doc, ids));
                  } catch (err) {
                    setActionError(String(err));
                  }
                } else {
                  const c = audioClips.find((x) => x.id === audioMenu.clipId);
                  if (!c) {
                    setAudioMenu(null);
                    return;
                  }
                  const sameTrack = (arrangement.audioClips ?? [])
                    .filter((ac) => ac.trackId === c.trackId)
                    .sort((a, b) => a.startBar - b.startBar);
                  const idx = sameTrack.findIndex((ac) => ac.id === c.id);
                  const nxt = sameTrack[idx + 1];
                  if (!nxt || Math.abs(nxt.startBar - (c.startBar + c.lengthBars)) > 0.5) {
                    setActionError("Need adjacent clip on same track");
                    setAudioMenu(null);
                    return;
                  }
                  try {
                    execute(consolidateAudioClips(services.store.doc, [c.id, nxt.id]));
                  } catch (err) {
                    setActionError(String(err));
                  }
                }
                setAudioMenu(null);
              }}
            >
              Consolidate (Shift+Tab+B)
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const c = audioClips.find((x) => x.id === audioMenu.clipId);
                if (c) execute(duplicateAudioClip(services.store.doc, c.id));
                setAudioMenu(null);
              }}
            >
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              className="btn-danger"
              onClick={() => {
                const id = audioMenu.clipId;
                execute(deleteAudioClip(services.store.doc, id));
                if (selectedAudioClipId === id) setSelectedAudioClipId(null);
                setAudioMenu(null);
              }}
            >
              Delete
            </button>
            <button type="button" role="menuitem" onClick={() => setAudioMenu(null)}>
              Close
            </button>
          </div>
        )}
        {actionError && (
          <div className="arr-error" role="status">
            {actionError}
          </div>
        )}
        {spectralEditClipId &&
          (() => {
            const c = audioClips.find((x) => x.id === spectralEditClipId);
            const buf = c ? services.bank.get(c.bufferId) : null;
            if (!c || !buf) return null;
            return <SpectralEditPanel clip={c} buffer={buf} onClose={() => setSpectralEditClipId(null)} />;
          })()}
      </div>
    </section>
  );
}

/**
 * Transient times for one waveform's onset dots. Resolves from the shared
 * warp-onset cache (warmed by the arrangement effect); every hook awaiting
 * the same buffer shares one detection promise.
 */
function useOnsetDots(bufferId: string, enabled: boolean): number[] | null {
  const services = useServices();
  const [times, setTimes] = useState<number[] | null>(() => warpOnsetCache.get(bufferId) ?? null);
  useEffect(() => {
    if (!enabled) {
      setTimes(null);
      return;
    }
    const cached = warpOnsetCache.get(bufferId);
    if (cached) {
      setTimes(cached);
      return;
    }
    let live = true;
    const p = getWarpOnsets(services.bank, bufferId);
    if (!p) {
      setTimes(null);
      return;
    }
    p.then((result) => {
      if (live) setTimes(result);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferId, enabled]);
  return times;
}

function AudioClipWaveform({
  buffer,
  bufferId,
  reverse,
  showOnsets,
}: {
  buffer: AudioBuffer | null;
  bufferId: string;
  reverse: boolean;
  showOnsets: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onsets = useOnsetDots(bufferId, showOnsets && buffer !== null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !buffer) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const data = buffer.getChannelData(0);
    const columns = Math.min(w, 240);
    const per = Math.floor(data.length / columns);
    const dim = getComputedStyle(canvas).getPropertyValue("--text-faint") || "#3a3d44";
    const rawAccent = getComputedStyle(canvas).getPropertyValue("--accent") || "#f59e0b";
    const baseHex = reverse ? "#f87171" : rawAccent.trim();
    const rgb = hexToRgb(baseHex) ?? [245, 158, 11];
    // Molten body: bright core fading to transparent at the extremes.
    const body = ctx.createLinearGradient(0, 0, 0, h);
    body.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.12)`);
    body.addColorStop(0.5, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.95)`);
    body.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.12)`);
    ctx.strokeStyle = body;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let c = 0; c < columns; c++) {
      let min = 1,
        max = -1;
      const s = c * per,
        e = Math.min((c + 1) * per, data.length);
      for (let i = s; i < e; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const x = (c / columns) * w;
      const y0 = h / 2 - max * (h / 2 - 2);
      const y1 = h / 2 - min * (h / 2 - 2);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.stroke();
    // Transient ticks: where the warp magnet would grab (selected/warped clips).
    if (onsets && onsets.length > 0 && buffer.duration > 0) {
      ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.6)`;
      for (const t of onsets) {
        const x = (t / buffer.duration) * w;
        if (x < 0 || x > w) continue;
        ctx.fillRect(x - 1, h - 6, 2, 5);
      }
    }
    // faint envelope line like WavetablePreview
    ctx.strokeStyle = dim;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, w, h);
  }, [buffer, bufferId, reverse, showOnsets, onsets]);
  if (!buffer) return <div className="audio-waveform-empty">no buffer</div>;
  return (
    <canvas
      ref={ref}
      className="audio-waveform"
      style={{ width: "100%", height: 28 }}
      aria-label="Audio waveform (min/max envelope like WavetablePreview)"
    />
  );
}

/**
 * Draggable warp pins directly on the audio waveform (FL/Slicex-style).
 *
 * Each pin locks one sample time to one grid position; dragging it
 * horizontally bends time around it (pitch follows in Resample clips,
 * pitch is preserved in Stretch clips). Model edits commit through the
 * same undoable `updateAudioClip` command as every other clip edit.
 *
 * - drag: move the pin in time (Shift = snap to 1/16)
 * - double-click empty waveform: add a neutral pin (sound does not jump)
 * - Alt-click / right-click a pin: delete it
 */
function WarpPinsOverlay({
  clip,
  disabledReason,
  onCommit,
}: {
  clip: AudioClip;
  disabledReason: string | null;
  onCommit: (markers: { timeSec: number; tick: number }[]) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ index: number; originTick: number; startX: number; moved: boolean } | null>(null);
  const [dragTick, setDragTick] = useState<number | null>(null);
  const markers = clip.warpMarkers ?? [];
  if (markers.length === 0) return null;
  const clipStartTick = clip.startBar * BAR_TICKS;
  const clipTicks = clip.lengthBars * BAR_TICKS;
  if (!(clipTicks > 0)) return null;

  const commitMove = (index: number, tick: number) => {
    const target = markers[index];
    if (!target) return;
    const clamped = Math.max(clipStartTick + 1, Math.min(clipStartTick + clipTicks - 1, Math.round(tick)));
    if (clamped === target.tick) return;
    const next = markers.map((m, i) => (i === index ? { ...m, tick: clamped } : m));
    next.sort((a, b) => a.tick - b.tick);
    onCommit(next.slice(0, 256));
  };

  const commitDelete = (index: number) => {
    onCommit(markers.filter((_, i) => i !== index));
  };

  return (
    <div ref={overlayRef} className="warp-pins-overlay" aria-label={`Warp pins (${markers.length})`}>
      {markers.map((m, i) => {
        const tick = dragRef.current?.index === i && dragTick !== null ? dragTick : m.tick;
        const leftPct = ((tick - clipStartTick) / clipTicks) * 100;
        if (leftPct < 0 || leftPct > 100) return null;
        const bar = Math.floor(tick / BAR_TICKS) + 1;
        return (
          <div
            key={`${m.tick}-${m.timeSec}-${i}`}
            className={`warp-pin${disabledReason ? " disabled" : ""}${dragRef.current?.index === i ? " dragging" : ""}`}
            style={{ left: `${leftPct}%` }}
          >
            <div className="warp-pin-line" />
            <button
              type="button"
              className="warp-pin-handle"
              aria-label={`Warp pin ${i + 1}, bar ${bar}, sample ${m.timeSec.toFixed(2)}s — drag to bend time, Alt-click or right-click to delete`}
              title={
                disabledReason ??
                `Warp pin · bar ${bar} · ${m.timeSec.toFixed(2)}s — drag to bend (Shift = snap 1/16), Alt-click / right-click deletes`
              }
              onPointerDown={(e) => {
                if (disabledReason) return;
                if (e.button !== 0) return;
                if (e.altKey) {
                  e.stopPropagation();
                  e.preventDefault();
                  commitDelete(i);
                  return;
                }
                e.stopPropagation();
                e.preventDefault();
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* no capture */
                }
                dragRef.current = { index: i, originTick: m.tick, startX: e.clientX, moved: false };
                setDragTick(m.tick);
              }}
              onPointerMove={(e) => {
                const drag = dragRef.current;
                if (!drag || drag.index !== i) return;
                const overlay = overlayRef.current;
                const width = overlay?.getBoundingClientRect().width ?? 0;
                if (width <= 0) return;
                const dx = e.clientX - drag.startX;
                if (!drag.moved && Math.abs(dx) < 3) return;
                drag.moved = true;
                let next = drag.originTick + (dx / width) * clipTicks;
                if (e.shiftKey) next = Math.round(next / STEP_TICKS) * STEP_TICKS;
                setDragTick(Math.max(clipStartTick + 1, Math.min(clipStartTick + clipTicks - 1, Math.round(next))));
              }}
              onPointerUp={(e) => {
                const drag = dragRef.current;
                if (!drag || drag.index !== i) return;
                dragRef.current = null;
                const final = dragTick;
                setDragTick(null);
                if (!drag.moved || final === null) return;
                e.stopPropagation();
                commitMove(i, final);
              }}
              onPointerCancel={() => {
                if (dragRef.current?.index !== i) return;
                dragRef.current = null;
                setDragTick(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!disabledReason) commitDelete(i);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

const INTENSITY_LANE_HEIGHT = 44;
const INTENSITY_NEUTRAL = 0.7;

interface IntensityHandle {
  sceneId: string;
  /** Index into the SCENE's full curve array (points outside visible windows keep their slot). */
  index: number;
  /** Absolute tick of the point (clip start + scene-local offset). */
  absTick: number;
  value: number;
}

/**
 * Scene-intensity lane on the arrangement timeline (VISION §11): the engine
 * already schedules `scene.intensityCurve` live and offline — this lane makes
 * the curve VISIBLE and editable in place. One strip under the clip lane,
 * one curve segment per scene clip window, points committed through the same
 * undoable `setSceneIntensityCurve` command the ModPanel editor uses.
 */
function IntensityLane({
  scenes,
  clips,
  totalBars,
  playheadBar,
  barWidth,
  onEdit,
}: {
  scenes: ProjectDocument["scenes"];
  clips: ArrangementClip[];
  totalBars: number;
  playheadBar: number;
  barWidth: number;
  onEdit: (sceneId: string, curve: IntensityPoint[]) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    sceneId: string;
    index: number;
    curve: IntensityPoint[];
    origOffset: number;
    origValue: number;
    /** Absolute tick of the handle when the drag began. */
    originAbsTick: number;
  } | null>(null);
  const [live, setLive] = useState<{ sceneId: string; index: number; absTick: number; value: number } | null>(null);
  const width = totalBars * barWidth;
  const pxPerTick = barWidth / BAR_TICKS;
  const yFor = (value: number) => INTENSITY_LANE_HEIGHT - value * INTENSITY_LANE_HEIGHT;

  const scenesById = new Map(scenes.map((s) => [s.id, s]));
  /** Points of every scene curve that fall inside their owning clip window. */
  const handles: IntensityHandle[] = [];
  const segments: {
    key: string;
    sceneId: string;
    clipStartTick: number;
    clipEndTick: number;
    points: IntensityPoint[];
  }[] = [];
  for (const clip of clips) {
    const scene = scenesById.get(clip.sceneId);
    if (!scene) continue;
    const clipStartTick = clip.startBar * BAR_TICKS;
    const clipEndTick = clipStartTick + clip.lengthBars * BAR_TICKS;
    const curve = scene.intensityCurve ?? [];
    const points: IntensityPoint[] = [];
    curve.forEach((p, index) => {
      const absTick = clipStartTick + p.offset;
      if (absTick < clipStartTick || absTick > clipEndTick) return;
      handles.push({ sceneId: scene.id, index, absTick, value: p.value });
      points.push(p);
    });
    segments.push({ key: `${scene.id}:${clipStartTick}`, sceneId: scene.id, clipStartTick, clipEndTick, points });
  }

  const renderHandles = live
    ? handles.map((h) =>
        h.sceneId === live.sceneId && h.index === live.index ? { ...h, absTick: live.absTick, value: live.value } : h,
      )
    : handles;

  const localFromEvent = (event: React.PointerEvent): { absTick: number; value: number } | null => {
    const lane = laneRef.current;
    if (!lane) return null;
    const rect = lane.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    return {
      absTick: Math.round(x / pxPerTick / STEP_TICKS) * STEP_TICKS,
      value: Math.min(1, Math.max(0, 1 - y / INTENSITY_LANE_HEIGHT)),
    };
  };

  const handleAt = (event: { clientX: number; clientY: number }): IntensityHandle | null => {
    const lane = laneRef.current;
    if (!lane) return null;
    const rect = lane.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: { handle: IntensityHandle; dist: number } | null = null;
    for (const handle of handles) {
      const dx = Math.abs(handle.absTick * pxPerTick - x);
      const dy = Math.abs(yFor(handle.value) - y);
      if (dx < 9 && dy < 9 && (!best || dx + dy < best.dist)) best = { handle, dist: dx + dy };
    }
    return best?.handle ?? null;
  };

  const clipAt = (absTick: number): ArrangementClip | null =>
    clips.find((c) => absTick >= c.startBar * BAR_TICKS && absTick < (c.startBar + c.lengthBars) * BAR_TICKS) ?? null;

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const local = localFromEvent(event);
    if (!local) return;
    const hit = handleAt(event);
    if (hit) {
      const scene = scenesById.get(hit.sceneId);
      if (!scene) return;
      const curve = [...(scene.intensityCurve ?? [])];
      dragRef.current = {
        sceneId: hit.sceneId,
        index: hit.index,
        curve,
        origOffset: curve[hit.index]?.offset ?? 0,
        origValue: curve[hit.index]?.value ?? 0,
        originAbsTick: hit.absTick,
      };
      setLive({ sceneId: hit.sceneId, index: hit.index, absTick: hit.absTick, value: hit.value });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    // Empty space inside a clip window: add a point (quantized to a step).
    const clip = clipAt(local.absTick);
    if (!clip) return;
    const scene = scenesById.get(clip.sceneId);
    if (!scene) return;
    const offset = local.absTick - clip.startBar * BAR_TICKS;
    onEdit(scene.id, [...(scene.intensityCurve ?? []), { offset, value: local.value }]);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const local = localFromEvent(event);
    if (!local) return;
    const clip =
      clipAt(local.absTick) ??
      clipAt(handles.find((h) => h.sceneId === drag.sceneId && h.index === drag.index)?.absTick ?? -1);
    if (!clip) return;
    const offset = Math.max(0, Math.min(clip.lengthBars * BAR_TICKS, local.absTick - clip.startBar * BAR_TICKS));
    setLive({
      sceneId: drag.sceneId,
      index: drag.index,
      absTick: clip.startBar * BAR_TICKS + offset,
      value: local.value,
    });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    const livePos = live;
    dragRef.current = null;
    setLive(null);
    if (!drag || !livePos) return;
    const clip = clipAt(livePos.absTick);
    if (!clip) return;
    const newOffset = livePos.absTick - clip.startBar * BAR_TICKS;
    // The dragged handle's scene-local origin (its offset when the drag began).
    const originClip = clipAt(drag.originAbsTick);
    const origOffset = originClip ? drag.originAbsTick - originClip.startBar * BAR_TICKS : drag.origOffset;
    if (newOffset === origOffset && livePos.value === drag.origValue) return;
    const updated = [...drag.curve];
    updated[drag.index] = { offset: newOffset, value: livePos.value };
    onEdit(drag.sceneId, updated);
  };

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const hit = handleAt(event);
    if (!hit) return;
    const scene = scenesById.get(hit.sceneId);
    if (!scene) return;
    onEdit(
      hit.sceneId,
      (scene.intensityCurve ?? []).filter((_, i) => i !== hit.index),
    );
  };

  // Live value readout at the playhead (the number the engine feeds macros).
  const activeClip = clips.find(
    (clip) => playheadBar >= clip.startBar && playheadBar < clip.startBar + clip.lengthBars,
  );
  const activeScene = activeClip ? scenesById.get(activeClip.sceneId) : undefined;
  const playheadValue =
    activeClip && activeScene
      ? computeSceneIntensity(activeScene, activeClip.startBar * BAR_TICKS, Math.round(playheadBar * BAR_TICKS))
      : null;

  return (
    <div
      className="arr-intensity-lane"
      ref={laneRef}
      style={{ width }}
      data-playhead-value={playheadValue !== null ? playheadValue.toFixed(2) : undefined}
      title="Scene intensity — click to add a point, drag to shape, right-click to delete"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
        setLive(null);
      }}
      onContextMenu={onContextMenu}
    >
      <span className="arr-intensity-label">INTENSITY</span>
      {playheadValue !== null && <span className="arr-intensity-value">{Math.round(playheadValue * 100)}%</span>}
      <div className="arr-intensity-neutral" style={{ top: yFor(INTENSITY_NEUTRAL) }} />
      {segments.map((segment) => (
        <div
          key={segment.key}
          className="arr-intensity-clipspan"
          style={{
            left: segment.clipStartTick * pxPerTick,
            width: (segment.clipEndTick - segment.clipStartTick) * pxPerTick,
          }}
        />
      ))}
      <svg className="arr-intensity-svg" width={width} height={INTENSITY_LANE_HEIGHT}>
        {segments.map((segment) => {
          const pts = segment.points
            .map((p) => {
              const handle = renderHandles.find(
                (h) => h.sceneId === segment.sceneId && h.absTick === segment.clipStartTick + p.offset,
              );
              const value = handle ? handle.value : p.value;
              return `${(segment.clipStartTick + p.offset) * pxPerTick},${yFor(value)}`;
            })
            .join(" ");
          return pts ? <polyline key={segment.key} className="arr-intensity-line" points={pts} /> : null;
        })}
      </svg>
      {renderHandles.map((handle, i) => (
        <span
          key={`${handle.sceneId}:${handle.index}:${i}`}
          className="arr-intensity-point"
          style={{ left: handle.absTick * pxPerTick, top: yFor(handle.value) }}
        />
      ))}
    </div>
  );
}
