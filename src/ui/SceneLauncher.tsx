import { useRef, useState, useSyncExternalStore } from "react";
import { useDoc, useServices } from "./context";
import { sceneRoleOf } from "../project-model/schema";
import { assistVary } from "../commands/commands";
import type { Pattern, Scene } from "../project-model/types";
import type { PlayMode } from "../project-model/types";

export interface SceneLauncherProps {
  variant: "bar" | "panel";
  playheadBar: number;
  selectedSceneId?: string;
  onSelectScene?: (scene: Scene) => void;
  onRenameScene?: (scene: Scene, name: string) => void;
  onDeleteScene?: (scene: Scene) => void;
  onReorderScenes?: (fromIndex: number, toIndex: number) => void;
  onDuplicatePattern?: (scene: Scene) => void;
}

interface SceneRuntimeState {
  mode: PlayMode;
  playing: boolean;
  pendingPatternId: string | null;
}

export function useSceneRuntimeState(): SceneRuntimeState {
  const services = useServices();
  useSyncExternalStore(
    (listener) => {
      const unsubPlayback = services.playback.subscribe(listener);
      const unsubScheduler = services.scheduler.subscribe(listener);
      return () => {
        unsubPlayback();
        unsubScheduler();
      };
    },
    () =>
      `${services.playback.mode}:${services.transport.playing ? "playing" : "stopped"}:${services.scheduler.pendingPatternId ?? ""}`,
    () => "pattern:stopped:",
  );
  return {
    mode: services.playback.mode,
    playing: services.transport.playing,
    pendingPatternId: services.scheduler.pendingPatternId,
  };
}

function patternLengthLabel(pattern: Pattern | undefined): string {
  if (!pattern) return "PATTERN MISSING";
  const bars = Math.max(1, Math.ceil(pattern.stepCount / 16));
  return `${bars} ${bars === 1 ? "BAR" : "BARS"} · ${pattern.stepCount} STEP`;
}

function currentSceneIdFor(
  mode: PlayMode,
  activePatternId: string,
  scenes: Scene[],
  clips: Array<{ sceneId: string; startBar: number; lengthBars: number }>,
  playheadBar: number,
): string | null {
  if (mode === "song") {
    const clip = clips.find(
      (candidate) => playheadBar >= candidate.startBar && playheadBar < candidate.startBar + candidate.lengthBars,
    );
    return clip?.sceneId ?? null;
  }
  return scenes.find((scene) => scene.patternId === activePatternId)?.id ?? null;
}

export function SceneLauncher({
  variant,
  playheadBar,
  selectedSceneId: selectedSceneIdProp,
  onSelectScene,
  onRenameScene,
  onDeleteScene,
  onReorderScenes,
  onDuplicatePattern,
}: SceneLauncherProps) {
  const services = useServices();
  const doc = useDoc();
  const runtime = useSceneRuntimeState();
  const [localSelectedSceneId, setLocalSelectedSceneId] = useState<string | null>(null);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draggedSceneIndex, setDraggedSceneIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const currentSceneId = currentSceneIdFor(
    runtime.mode,
    doc.activePatternId,
    doc.scenes,
    doc.arrangement.clips,
    playheadBar,
  );
  const selectedSceneId = selectedSceneIdProp ?? localSelectedSceneId ?? currentSceneId ?? doc.scenes[0]?.id ?? null;
  const selectedScene = doc.scenes.find((scene) => scene.id === selectedSceneId) ?? doc.scenes[0];
  const canReorder = Boolean(onReorderScenes);

  const selectScene = (scene: Scene) => {
    setLocalSelectedSceneId(scene.id);
    onSelectScene?.(scene);
  };

  const beginEdit = (scene: Scene) => {
    selectScene(scene);
    setEditingSceneId(scene.id);
    setDraftName(scene.name);
  };

  const commitEdit = () => {
    if (!editingSceneId) return;
    const scene = doc.scenes.find((candidate) => candidate.id === editingSceneId);
    const name = draftName.trim();
    if (scene && name && name !== scene.name) onRenameScene?.(scene, name);
    setEditingSceneId(null);
  };

  const handleDragStart = (event: React.DragEvent, scene: Scene, index: number) => {
    setDraggedSceneIndex(index);
    event.dataTransfer.setData("application/x-pulse-forge-scene", scene.id);
    event.dataTransfer.effectAllowed = canReorder ? "copyMove" : "copy";
  };

  const handleDrop = (event: React.DragEvent, toIndex: number) => {
    event.preventDefault();
    if (draggedSceneIndex !== null && onReorderScenes && draggedSceneIndex !== toIndex) {
      onReorderScenes(draggedSceneIndex, toIndex);
    }
    setDraggedSceneIndex(null);
  };

  // Touch reorder: HTML5 drag-and-drop never fires on touch, so the scene
  // list reorders through pointer events — press the card's grip, drag over
  // the target slot, release. Same contract as the pattern chips.
  const pointerDragRef = useRef<{ fromIndex: number; toIndex: number } | null>(null);

  const sceneIndexFromPoint = (clientY: number): number => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>(".scene-launch-card");
    if (!cards || cards.length === 0) return 0;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return cards.length - 1;
  };

  const beginPointerReorder = (event: React.PointerEvent, index: number) => {
    if (!canReorder || !onReorderScenes) return;
    if (event.pointerType === "mouse") return; // mouse uses native DnD
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pointerDragRef.current = { fromIndex: index, toIndex: index };
    setDraggedSceneIndex(index);
  };

  const movePointerReorder = (event: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag) return;
    drag.toIndex = sceneIndexFromPoint(event.clientY);
  };

  const endPointerReorder = (event: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    setDraggedSceneIndex(null);
    if (!drag || !onReorderScenes) return;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (drag.toIndex !== drag.fromIndex) onReorderScenes(drag.fromIndex, drag.toIndex);
  };

  const cancelPointerReorder = () => {
    pointerDragRef.current = null;
    setDraggedSceneIndex(null);
  };

  return (
    <div className={`scene-launcher scene-launcher-${variant}`} aria-label="Scene launcher">
      <div className="scene-launcher-list" ref={listRef}>
        {doc.scenes.map((scene, index) => {
          const pattern = doc.patterns.find((candidate) => candidate.id === scene.patternId);
          const useCount = doc.scenes.filter((candidate) => candidate.patternId === scene.patternId).length;
          const role = sceneRoleOf(scene);
          const isSelected = selectedSceneId === scene.id;
          const isCurrent = currentSceneId === scene.id;
          const isPlaying = runtime.playing && isCurrent;
          const isQueued = runtime.pendingPatternId !== null && runtime.pendingPatternId === scene.patternId;
          const isEditing = editingSceneId === scene.id;
          const classes = [
            "scene-launch-card",
            role ? `role-${role}` : "",
            isSelected ? "selected" : "",
            isCurrent ? "current" : "",
            isPlaying ? "playing" : "",
            isQueued ? "queued" : "",
            draggedSceneIndex === index ? "dragging" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={scene.id}
              className={classes}
              draggable={canReorder || variant === "panel"}
              onDragStart={(event) => handleDragStart(event, scene, index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(event, index)}
              onDragEnd={() => setDraggedSceneIndex(null)}
              title={`${scene.name} · ${pattern?.name ?? "Pattern missing"} · click SELECT, use LAUNCH to play${canReorder ? " — drag the card to reorder" : ""}`}
            >
              {canReorder && !isEditing && (
                <button
                  type="button"
                  className="scene-drag-grip"
                  aria-label={`Reorder ${scene.name} — drag up or down`}
                  title="Drag to reorder (touch-friendly)"
                  onPointerDown={(event) => beginPointerReorder(event, index)}
                  onPointerMove={movePointerReorder}
                  onPointerUp={endPointerReorder}
                  onPointerCancel={cancelPointerReorder}
                >
                  ⠿
                </button>
              )}
              {isEditing ? (
                <input
                  className="scene-edit-input"
                  value={draftName}
                  autoFocus
                  aria-label={`Edit ${scene.name} name`}
                  onChange={(event) => setDraftName(event.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setEditingSceneId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="scene-select-control"
                  aria-label={`Select scene ${scene.name}`}
                  aria-pressed={isSelected}
                  onClick={() => selectScene(scene)}
                  onDoubleClick={() => beginEdit(scene)}
                >
                  <span className="scene-select-main">
                    <span className="scene-select-name">{scene.name}</span>
                    {role && <span className="scene-role-badge">{role.toUpperCase()}</span>}
                  </span>
                  <span className="scene-select-meta">
                    <span>{pattern?.name ?? "PATTERN MISSING"}</span>
                    <span>{patternLengthLabel(pattern)}</span>
                    <span className={useCount > 1 ? "scene-shared" : ""}>
                      {useCount > 1 ? `SHARED ${useCount}x` : `USE 1x`}
                    </span>
                    {scene.loop && <span className="scene-loop-badge">LOOP</span>}
                  </span>
                </button>
              )}

              <div className="scene-state-badges" aria-live="polite">
                {isPlaying ? (
                  <span className="scene-state-badge playing">PLAYING</span>
                ) : (
                  isCurrent && <span className="scene-state-badge current">CURRENT</span>
                )}
                {isQueued && <span className="scene-state-badge queued">QUEUED</span>}
              </div>

              <div className="scene-launch-actions">
                <button
                  type="button"
                  className="scene-action scene-action-launch"
                  aria-label={`Launch scene ${scene.name}`}
                  title="LAUNCH scene. While playing, switches on the next bar."
                  onClick={() => {
                    selectScene(scene);
                    services.playback.launchScene(scene);
                  }}
                >
                  {variant === "panel" ? "LAUNCH" : "▶"}
                </button>
                <button
                  type="button"
                  className="scene-action scene-action-edit"
                  aria-label={`Vary scene ${scene.name}`}
                  title="VARY — re-roll this scene's pattern live (dice variation, undoable). Takes effect within a beat."
                  onClick={(event) => {
                    event.stopPropagation();
                    const seed = `v-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
                    try {
                      services.store.execute(assistVary(services.store.doc, scene.patternId, seed, 0.5));
                    } catch {
                      /* pattern missing — nothing to vary */
                    }
                  }}
                >
                  {variant === "panel" ? "VARY" : "⟳"}
                </button>
                {onRenameScene && (
                  <button
                    type="button"
                    className="scene-action scene-action-edit"
                    aria-label={`Edit scene ${scene.name}`}
                    title="EDIT scene name"
                    onClick={() => beginEdit(scene)}
                  >
                    {variant === "panel" ? "EDIT" : "✎"}
                  </button>
                )}
                {onDeleteScene && (
                  <button
                    type="button"
                    className="scene-action scene-action-delete"
                    aria-label={`Delete scene ${scene.name}`}
                    title="Delete scene and its arrangement clips"
                    onClick={() => onDeleteScene(scene)}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {onDuplicatePattern && selectedScene && (
        <div className="scene-launcher-footer">
          <button
            type="button"
            className="btn btn-small scene-duplicate-pattern"
            title="Create a new independent pattern for the selected scene"
            onClick={() => onDuplicatePattern(selectedScene)}
          >
            DUPLICATE PATTERN
          </button>
          {doc.scenes.filter((scene) => scene.patternId === selectedScene.patternId).length > 1 && (
            <span className="scene-shared-note">
              Selected scene shares its pattern. Duplicate it before editing independently.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
