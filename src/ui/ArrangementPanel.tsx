import { useRef, useState } from "react";
import { useArrangementCapture, useDoc, useSelection, useSelectionStore, useServices } from "./context";
import {
  addArrangementClip,
  addArrangementTransition,
  addMarker,
  createArrangementSkeleton,
  createScene,
  createVariationAndPlaceClip,
  deleteArrangementClip,
  deleteScene,
  duplicateArrangementClip,
  duplicatePatternForScene,
  duplicateSceneAsVariation,
  moveArrangementClip,
  removeArrangementTransition,
  removeMarker,
  renameScene,
  reorderScenes,
  resizeArrangementClip,
  setSceneRole,
  updateArrangementTransition,
} from "../commands/commands";
import { sceneRoleOf } from "../project-model/schema";
import type { ArrangementTransitionType, SceneRole } from "../project-model/types";
import { BAR_TICKS, PPQ } from "../project-model/types";
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

  const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
  const totalBars = Math.max(16, ...clips.map((clip) => clip.startBar + clip.lengthBars + 4));
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
            <button type="button" className="btn btn-small" onClick={() => setShowSkeletonPreview((value) => !value)}>
              BUILD SKELETON
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
              if (event.target !== laneRef.current || event.button !== 0) return;
              if (selectedScene) placeScene(selectedScene.id, barFromEvent(event));
              setSelectedClipId(null);
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
        {actionError && (
          <div className="arr-error" role="status">
            {actionError}
          </div>
        )}
      </div>
    </section>
  );
}
