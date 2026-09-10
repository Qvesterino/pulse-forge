import { useEffect, useRef, useState } from "react";
import { useArrangementCapture, useDoc, useSelection, useSelectionStore, useServices } from "./context";
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
import { computeSceneIntensity } from "../project-model/intensity";
import type {
  ArrangementClip,
  ArrangementTransitionType,
  IntensityPoint,
  ProjectDocument,
  SceneRole,
} from "../project-model/types";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { extractGroove } from "../audio-engine/groove-extract";
import { analyzeLoopForFlip, buildFlipOptions, flipSeed } from "../ai/flip";
import { extensionForMime } from "../audio-engine/recorder";
import { userSampleId } from "../persistence/UserSampleRepository";
import { buildBounceZoneDoc } from "../rendering/bounce";
import { renderProject } from "../rendering/renderer";
import { encodeWav } from "../rendering/wav";
import { clipLengthBars, recordingStartBar } from "./timelineRec";
import { usePlayheadBar } from "./playhead";
import { SceneLauncher, useSceneRuntimeState } from "./SceneLauncher";

const BASE_BAR_WIDTH = 30;
const LANE_HEIGHT = 56;
const SCENE_ROLES: Array<{ value: SceneRole | ""; label: string }> = [
  { value: "", label: "INFER FROM NAME" },
  { value: "intro", label: "INTRO" },
  { value: "build", label: "BUILD" },
  { value: "drop", label: "DROP" },
  { value: "break", label: "BREAK" },
  { value: "outro", label: "OUTRO" },
  { value: "fill", label: "FILL" },
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
  const doc = useDoc();
  const capture = useArrangementCapture();
  const [selectedSceneId, setSelectedSceneId] = useState(doc.scenes[0]?.id ?? "");
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
  const [recState, setRecState] = useState<"idle" | "recording" | "saving">("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recRef = useRef<import("../audio-engine/recorder").LiveRecorder | null>(null);
  const recStartBarRef = useRef(0);

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
  useEffect(
    () => () => {
      recRef.current?.cancel();
      recRef.current = null;
    },
    [],
  );

  const startRec = async () => {
    if (!armedTrackId || recState !== "idle") return;
    setRecError(null);
    try {
      services.engine.ensureContext();
      const ctx = services.engine.getLiveAudioContext();
      if (!ctx) throw new Error("Audio engine is not ready");
      // The recorder loads as a lazy chunk — first REC fetches it.
      const { LiveRecorder } = await import("../audio-engine/recorder");
      const rec = new LiveRecorder({
        ctx,
        getTapNode: () => null, // mic input, not an internal tap
      });
      await rec.start({ kind: "mic" });
      recStartBarRef.current = Math.max(0, recordingStartBar(services.transport.position));
      recRef.current = rec;
      setRecSeconds(0);
      setRecState("recording");
      // Performers record against the backing track — roll the transport.
      if (!services.transport.playing) services.playback.playPause();
    } catch (error) {
      setRecError(error instanceof Error ? error.message : String(error));
    }
  };

  const stopRec = async () => {
    const rec = recRef.current;
    if (!rec) return;
    setRecState("saving");
    try {
      const take = await rec.stop();
      recRef.current = null;
      if (!take || take.buffer.duration < 0.1) {
        setRecError("Nothing captured — play/sing while recording");
        setRecState("idle");
        return;
      }
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const bufferId = userSampleId(`rec-${stamp}`);
      services.bank.add(bufferId, take.buffer);
      // Persist the bytes so the take survives reloads (best effort — the
      // in-memory bank already plays it this session).
      try {
        const asset = {
          id: bufferId,
          name: `REC ${stamp}`,
          fileName: `${bufferId}${extensionForMime(take.blob.type)}`,
          category: "Custom" as const,
          duration: take.buffer.duration,
          sampleRate: take.buffer.sampleRate,
          channels: take.buffer.numberOfChannels,
          createdAt: new Date().toISOString(),
        };
        await services.userSamples.save(asset, await take.blob.arrayBuffer());
      } catch {
        /* session-only take */
      }
      const lengthBars = clipLengthBars(take.buffer.duration, doc.bpm);
      services.store.execute(
        addAudioClip(doc, armedTrackId, bufferId, recStartBarRef.current, lengthBars, {
          fadeIn: 0.005,
          fadeOut: 0.02,
        }),
      );
      setRecState("idle");
    } catch (error) {
      setRecError(error instanceof Error ? error.message : String(error));
      setRecState("idle");
      recRef.current = null;
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

  const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
  const audioClips = [...(doc.arrangement.audioClips ?? [])].sort((a, b) => a.startBar - b.startBar);
  const totalBars = Math.max(
    16,
    ...clips.map((clip) => clip.startBar + clip.lengthBars + 4),
    ...audioClips.map((c) => c.startBar + c.lengthBars + 4),
  );
  const selectedScene = doc.scenes.find((scene) => scene.id === selectedSceneId) ?? doc.scenes[0];
  const selectedClip = clips.find((clip) => clip.id === selectedClipId);
  const queuedScene = runtime.pendingPatternId
    ? doc.scenes.find((scene) => scene.patternId === runtime.pendingPatternId)
    : undefined;
  const selectedTransition = transitionBoundary
    ? doc.arrangement.transitions?.find(
        (transition) =>
          transition.fromClipId === transitionBoundary.fromClipId &&
          transition.toClipId === transitionBoundary.toClipId,
      )
    : undefined;

  const execute = (command: Parameters<typeof services.store.execute>[0]): void => {
    try {
      setActionError(null);
      services.store.execute(command);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Operation failed");
    }
  };

  const formatBarAsSeconds = (bar: number): string => {
    const sec = (bar * BAR_TICKS * 60) / (doc.bpm * PPQ);
    return `${sec.toFixed(1)}s`;
  };

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
      const scene = doc.scenes.find((sceneItem) => sceneItem.id === clip.sceneId);
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
    const trackIds = selection.trackIds.length > 0 ? selection.trackIds : doc.tracks.slice(0, 1).map((t) => t.id);
    setBouncingZone(true);
    try {
      // REAL bounce: offline-render the selected tracks (FX, groups, sends
      // included) for exactly the selected zone, then flip it to an audio
      // clip. No more placeholder sample standing in for the render.
      const zoneDoc = buildBounceZoneDoc(services.store.doc, trackIds, { startBar: fromBar, lengthBars: lenBars });
      const sr = services.engine.getLiveAudioContext()?.sampleRate ?? 44100;
      const buffer = await renderProject(zoneDoc, services.bank, { mode: "song", sampleRate: sr, tailSeconds: 0.35 });
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
      execute(addAudioClip(services.store.doc, trackIds[0], bufferId, fromBar, lenBars, { gain: 1, stretchRate: 1 }));
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
    const existing = doc.arrangement.transitions?.find(
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
            onClick={() => selectedScene && execute(duplicateSceneAsVariation(services.store.doc, selectedScene.id))}
          >
            DUPLICATE
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!selectedScene}
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
              {doc.tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </select>
            {recState === "recording" ? (
              <button type="button" className="btn btn-small btn-rec btn-rec-stop" onClick={() => void stopRec()}>
                ■ STOP {recSeconds.toFixed(0)}s
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-small btn-rec"
                title="Record the mic straight onto the armed track at the playhead (rolls the transport)"
                disabled={!armedTrackId || recState === "saving"}
                onClick={() => void startRec()}
              >
                ● REC
              </button>
            )}
            {recState === "saving" && <span className="arr-rec-saving">placing clip…</span>}
            {recError && <span className="arr-rec-error">{recError}</span>}
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

        {showSkeletonPreview && (
          <div className="arr-skeleton-preview">
            <span className="arr-skeleton-title">
              {clips.length > 0 ? "REPLACE CURRENT ARRANGEMENT:" : "ARRANGEMENT PREVIEW:"}
            </span>
            {(() => {
              const roles = ["intro", "build", "drop", "break", "outro"] as const;
              const preview = roles.flatMap((role) => {
                const scene = doc.scenes.find((candidate) => sceneRoleOf(candidate) === role);
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
              const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
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
              const closest = doc.markers
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
            {doc.markers.map((marker) => (
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
              const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
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
                      {doc.arrangement.transitions?.some(
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
              const track = doc.tracks.find((t) => t.id === clip.trackId);
              const buffer = services.bank.get(clip.bufferId);
              const effFadeIn = audioFadePreview?.clipId === clip.id ? audioFadePreview.fadeIn : (clip.fadeIn ?? 0);
              const effFadeOut = audioFadePreview?.clipId === clip.id ? audioFadePreview.fadeOut : (clip.fadeOut ?? 0);
              const effGain = audioGainPreview?.clipId === clip.id ? audioGainPreview.gain : (clip.gain ?? 1);
              return (
                <div
                  key={clip.id}
                  className={`arr-audio-clip${selected ? " selected" : ""}${isCurrent ? " current" : ""}`}
                  style={{ left: startBar * barWidth, width: lengthBars * barWidth - 4 }}
                  title={`${track?.name ?? clip.trackId} · ${clip.bufferId} · ${clip.reverse ? "REV " : ""}${clip.stretchMode === "stretch" ? `STRETCH×${clip.stretchRate.toFixed(2)} ` : clip.stretchRate !== 1 ? `×${clip.stretchRate.toFixed(2)} ` : ""}${lengthBars}b · trim ${clip.trimStart.toFixed(2)}/${clip.trimEnd.toFixed(2)} fade ${effFadeIn.toFixed(2)}/${effFadeOut.toFixed(2)} gain ${effGain.toFixed(2)} — PT: top corners fade, top middle clip gain`}
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
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setAudioMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <AudioClipWaveform buffer={buffer ?? null} reverse={clip.reverse} />
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
                doc={doc}
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
              {doc.scenes.find(
                (scene) => scene.id === clips.find((clip) => clip.id === transitionBoundary.fromClipId)?.sceneId,
              )?.name ?? "?"}{" "}
              →{" "}
              {doc.scenes.find(
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
                const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
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
                    stealGrooveIntoPattern(services.store.doc, services.store.doc.activePatternId, analysis.groove, {
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
                // Use onset-detector logic inline (synchronous) to slice to pads
                const data = buf.getChannelData(0);
                const times: number[] = [];
                // quick transient detection (like onset-detector.ts but sync)
                const win = 1024,
                  hop = 256,
                  frames = Math.floor((data.length - win) / hop) + 1;
                if (frames > 4) {
                  const env = new Float64Array(frames);
                  for (let f = 0; f < frames; f++) {
                    let s = 0;
                    for (let i = f * hop; i < f * hop + win; i++) s += data[i] * data[i];
                    env[f] = Math.sqrt(s / win);
                  }
                  let globalMax = 0;
                  for (let f = 0; f < frames; f++) if (env[f] > globalMax) globalMax = env[f];
                  for (let f = 1; f < frames - 1; f++) {
                    if (env[f] > env[f - 1] && env[f] > env[f + 1] && env[f] > globalMax * 0.22)
                      times.push((f * hop) / buf.sampleRate);
                  }
                }
                const slices = [];
                for (let i = 0; i < Math.min(16, times.length + 1); i++) {
                  const start = i === 0 ? 0 : times[i - 1];
                  const end = i < times.length ? times[i] : buf.duration;
                  if (end - start > 0.02) slices.push({ start, end });
                }
                if (slices.length === 0) slices.push({ start: 0, end: buf.duration });
                const drumTrack = doc.tracks.find((t) => t.kind === "drum");
                if (!drumTrack) {
                  setActionError("No drum track");
                } else {
                  // Store bounced buffer as temp asset then slice
                  const bounceId = `stem-${c.id}`;
                  services.bank.add(bounceId, buf);
                  execute(sliceToPads(services.store.doc, drumTrack.id, bounceId, slices, "Slice"));
                }
                setAudioMenu(null);
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
                  const ids = (doc.arrangement.audioClips ?? [])
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
                  const sameTrack = (doc.arrangement.audioClips ?? [])
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
      </div>
    </section>
  );
}

function AudioClipWaveform({ buffer, reverse }: { buffer: AudioBuffer | null; reverse: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
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
    const accent = getComputedStyle(canvas).getPropertyValue("--accent") || "#f59e0b";
    ctx.strokeStyle = reverse ? "#f87171" : accent;
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
    // faint envelope line like WavetablePreview
    ctx.strokeStyle = dim;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, w, h);
  }, [buffer, reverse]);
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
  doc,
  clips,
  totalBars,
  playheadBar,
  barWidth,
  onEdit,
}: {
  doc: ProjectDocument;
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

  const scenesById = new Map(doc.scenes.map((s) => [s.id, s]));
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
