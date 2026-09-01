// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import { useArrangementCapture, useDoc, useSelection, useSelectionStore, useServices } from "./context";
import {
  addArrangementClip,
  addArrangementTransition,
  addAudioClip,
  addMarker,
  consolidateAudioClips,
  autoArrangeSong,
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
  resizeAudioClip,
  splitAudioClipAtTick,
  stripSilenceAudioClip,
  updateAudioClip,
  sliceToPads,
} from "../commands/commands";
import { sceneRoleOf } from "../project-model/schema";
import type { ArrangementTransitionType, SceneRole } from "../project-model/types";
import { BAR_TICKS, PPQ } from "../project-model/types";
import { detectLoopBpm } from "../audio-engine/bpm-detect";
import { extractGroove } from "../audio-engine/groove-extract";
import { usePlayheadBar } from "./playhead";
import { SceneLauncher, useSceneRuntimeState } from "./SceneLauncher";

const BAR_WIDTH = 30;
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
  const [showSkeletonPreview, setShowSkeletonPreview] = useState(false);
  const [transitionBoundary, setTransitionBoundary] = useState<TransitionBoundary | null>(null);
  const [transitionDraft, setTransitionDraft] = useState<TransitionDraft>({
    type: "custom",
    lengthBars: 1,
    cueAssetId: "",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<{ startBar: number; lengthBars: number } | null>(null);
  const playheadBar = usePlayheadBar(services.transport);
  const selection = useSelection();
  const selectionStore = useSelectionStore();
  const [timeDrag, setTimeDrag] = useState<{ startBar: number; currentBar: number } | null>(null);
  const runtime = useSceneRuntimeState();
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);
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
    return Math.max(0, Math.floor((event.clientX - rect.left) / BAR_WIDTH));
  };

  const seekFromRulerEvent = (event: React.PointerEvent) => {
    const lane = laneRef.current;
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    const bar = Math.max(0, (event.clientX - rect.left) / BAR_WIDTH);
    services.playback.seek(bar * BAR_TICKS);
  };
  void seekFromRulerEvent;

  const beginClipDrag = (event: React.PointerEvent, clipId: string, mode: "move" | "resize") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (!clip) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedClipId(clipId);
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
    if (current.mode === "move") {
      setDrag({ startBar: Math.max(0, current.origStart + bar - current.grabBar), lengthBars: current.origLength });
    } else {
      setDrag({ startBar: current.origStart, lengthBars: Math.max(1, bar - current.origStart + 1) });
    }
  };

  const onClipPointerUp = () => {
    const current = dragRef.current;
    const finalDrag = drag;
    dragRef.current = null;
    setDrag(null);
    if (!current || !finalDrag) return;
    if (current.mode === "move" && finalDrag.startBar !== current.origStart) {
      execute(moveArrangementClip(services.store.doc, current.clipId, finalDrag.startBar));
    }
    if (current.mode === "resize" && finalDrag.lengthBars !== current.origLength) {
      execute(resizeArrangementClip(services.store.doc, current.clipId, finalDrag.lengthBars));
    }
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
  const bounceZoneToClip = () => {
    if (!selection.timeRange) return;
    const fromBar = selection.timeRange.fromTick / BAR_TICKS;
    const lenBars = (selection.timeRange.toTick - selection.timeRange.fromTick) / BAR_TICKS;
    // Build stem for guardrail (group FX) — real bounce would render offline then store bufferId
    const trackIds = selection.trackIds.length > 0 ? selection.trackIds : doc.tracks.slice(0, 1).map((t) => t.id);
    const bufferId = doc.tracks[0] ? `bounce-${Date.now()}` : "factory.tonal.pluck";
    // Store a placeholder buffer in the bank so waveform can render (reuse first track sample if possible)
    const placeholder =
      services.bank.get(doc.tracks.find((t) => t.kind === "instrument")?.sampleId ?? "factory.tonal.pluck") ??
      services.bank.get("factory.tonal.pluck");
    if (placeholder) services.bank.add(bufferId, placeholder);
    execute(addAudioClip(services.store.doc, trackIds[0], bufferId, fromBar, lenBars, { gain: 1, stretchRate: 1 }));
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
            <button
              type="button"
              className={`btn btn-small${rulerMode === "seconds" ? " active-solo" : ""}`}
              onClick={() => setRulerMode(rulerMode === "bars" ? "seconds" : "bars")}
            >
              {rulerMode === "bars" ? "BARS" : "SECS"}
            </button>
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
              disabled={!selection.timeRange}
              title="Bounce zone (timeRange) to an editable AudioClip — stem built via buildStemProject, then rendered via OfflineAudioContext like track-renderer/frozen. Waveform: WavetablePreview min/max envelope; handles: trim/fade."
              onClick={bounceZoneToClip}
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

        <div className="arr-lane-scroll">
          <div
            className="arr-ruler"
            style={{ width: totalBars * BAR_WIDTH }}
            title="Click to seek · drag to select time range · shift+click adds a marker"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / BAR_WIDTH);
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
                Math.min(totalBars, (event.clientX - laneRef.current!.getBoundingClientRect().left) / BAR_WIDTH),
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
              (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
            }}
            onPointerLeave={() => {
              // keep drag active, don't clear
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              const x = event.clientX - laneRef.current!.getBoundingClientRect().left;
              const closest = doc.markers
                .map((marker) => ({ id: marker.id, dist: Math.abs((marker.tick / BAR_TICKS) * BAR_WIDTH - x) }))
                .filter((marker) => marker.dist < 8)
                .sort((a, b) => a.dist - b.dist)[0];
              if (closest) execute(removeMarker(services.store.doc, closest.id));
            }}
          >
            {Array.from({ length: Math.ceil(totalBars / 4) }, (_, index) => {
              const barNum = index * 4 + 1;
              return (
                <span key={index} className="arr-ruler-mark" style={{ left: index * 4 * BAR_WIDTH }}>
                  {rulerMode === "seconds" ? formatBarAsSeconds(barNum - 1) : barNum}
                </span>
              );
            })}
            {doc.markers.map((marker) => (
              <div
                key={marker.id}
                className={`arr-marker arr-marker-${marker.type}`}
                style={{ left: (marker.tick / BAR_TICKS) * BAR_WIDTH - 6 }}
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
                  left: (Math.min(selection.timeRange.fromTick, selection.timeRange.toTick) / BAR_TICKS) * BAR_WIDTH,
                  width: (Math.abs(selection.timeRange.toTick - selection.timeRange.fromTick) / BAR_TICKS) * BAR_WIDTH,
                }}
              />
            )}
            <div className="arr-playhead" style={{ left: playheadBar * BAR_WIDTH }} />
          </div>
          <div
            className="arr-lane"
            ref={laneRef}
            style={{ width: totalBars * BAR_WIDTH, height: LANE_HEIGHT }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              // FL: Ctrl+drag on lane → range select (Cubase Range Tool)
              if ((event.ctrlKey || event.metaKey) && event.target === laneRef.current) {
                const bar = Math.max(0, (event.clientX - laneRef.current!.getBoundingClientRect().left) / BAR_WIDTH);
                setTimeDrag({ startBar: bar, currentBar: bar });
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                event.preventDefault();
                return;
              }
              if (event.target !== laneRef.current) return;
              if (selectedScene) placeScene(selectedScene.id, barFromEvent(event));
              setSelectedClipId(null);
            }}
            onPointerMove={(event) => {
              if (!timeDrag) return;
              // Only handle lane Ctrl+drag here; ruler has its own handler
              if (!(event.ctrlKey || event.metaKey) && event.buttons === 1) {
                // If we started via lane Ctrl+drag, keep updating even if Ctrl released
              }
              const bar = Math.max(
                0,
                Math.min(totalBars, (event.clientX - laneRef.current!.getBoundingClientRect().left) / BAR_WIDTH),
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
              } catch {}
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const sceneId = event.dataTransfer.getData("application/x-pulse-forge-scene");
              if (sceneId) placeScene(sceneId, barFromEvent(event));
            }}
          >
            <div className="arr-playhead arr-playhead-lane" style={{ left: playheadBar * BAR_WIDTH }} />
            {selection.timeRange && (
              <div
                className="arr-time-range arr-time-range-lane"
                style={{
                  left: (Math.min(selection.timeRange.fromTick, selection.timeRange.toTick) / BAR_TICKS) * BAR_WIDTH,
                  width: (Math.abs(selection.timeRange.toTick - selection.timeRange.fromTick) / BAR_TICKS) * BAR_WIDTH,
                }}
              />
            )}
            {Array.from({ length: totalBars }, (_, index) => (
              <div
                key={index}
                className={`arr-bar-grid${index % 4 === 0 ? " bar-strong" : ""}`}
                style={{ left: index * BAR_WIDTH }}
              />
            ))}
            {clips.map((clip, index) => {
              const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
              const role = scene ? (sceneRoleOf(scene) ?? "custom") : "custom";
              const isDragging = dragRef.current?.clipId === clip.id && drag !== null;
              const startBar = isDragging ? drag.startBar : clip.startBar;
              const lengthBars = isDragging ? drag.lengthBars : clip.lengthBars;
              const nextClip = clips[index + 1];
              const selected = selectedClipId === clip.id;
              const isCurrentClip = playheadBar >= clip.startBar && playheadBar < clip.startBar + clip.lengthBars;
              return (
                <div key={clip.id}>
                  <div
                    className={`arr-clip role-${role}${selected ? " selected" : ""}${isCurrentClip ? " current" : ""}${runtime.playing && isCurrentClip ? " playing" : ""}`}
                    style={{ left: startBar * BAR_WIDTH, width: lengthBars * BAR_WIDTH - 4 }}
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
                    onClick={() => setSelectedClipId(clip.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      execute(deleteArrangementClip(services.store.doc, clip.id));
                      if (selectedClipId === clip.id) setSelectedClipId(null);
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
                      style={{ left: (clip.startBar + clip.lengthBars) * BAR_WIDTH - 8 }}
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
                  style={{ left: startBar * BAR_WIDTH, width: lengthBars * BAR_WIDTH - 4 }}
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
                              BAR_WIDTH,
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
                              BAR_WIDTH,
                          ),
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

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
