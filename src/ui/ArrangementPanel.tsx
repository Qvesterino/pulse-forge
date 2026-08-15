import { useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import {
  addArrangementClip,
  createScene,
  deleteArrangementClip,
  deleteScene,
  duplicateArrangementClip,
  moveArrangementClip,
  renameScene,
  resizeArrangementClip,
  setActivePattern,
} from "../commands/commands";

const BAR_WIDTH = 30;
const LANE_HEIGHT = 56;

interface DragState {
  mode: "move" | "resize";
  clipId: string;
  startBar: number;
  origStart: number;
  origLength: number;
  grabBar: number;
}

export function ArrangementPanel() {
  const services = useServices();
  const doc = useDoc();
  const [selectedSceneId, setSelectedSceneId] = useState(doc.scenes[0]?.id ?? "");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<{ startBar: number; lengthBars: number } | null>(null);

  const totalBars = Math.max(
    16,
    ...doc.arrangement.clips.map((c) => c.startBar + c.lengthBars + 4),
  );
  const selectedScene = doc.scenes.find((s) => s.id === selectedSceneId) ?? doc.scenes[0];

  const barFromEvent = (event: React.PointerEvent): number => {
    const lane = laneRef.current;
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    return Math.max(0, Math.floor((event.clientX - rect.left) / BAR_WIDTH));
  };

  const beginClipDrag = (event: React.PointerEvent, clipId: string, mode: "move" | "resize") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const clip = doc.arrangement.clips.find((c) => c.id === clipId);
    if (!clip) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedClipId(clipId);
    const state: DragState = {
      mode,
      clipId,
      startBar: clip.startBar,
      origStart: clip.startBar,
      origLength: clip.lengthBars,
      grabBar: barFromEvent(event),
    };
    dragRef.current = state;
    setDrag({ startBar: clip.startBar, lengthBars: clip.lengthBars });
  };

  const onClipPointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current) return;
    const bar = barFromEvent(event);
    if (current.mode === "move") {
      setDrag({
        startBar: Math.max(0, current.origStart + (bar - current.grabBar)),
        lengthBars: current.origLength,
      });
    } else {
      setDrag({
        startBar: current.origStart,
        lengthBars: Math.max(1, bar - current.origStart + (bar > current.origStart ? 1 : 0) || 1),
      });
    }
  };

  const onClipPointerUp = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current || !drag) return;
    if (current.mode === "move" && drag.startBar !== current.origStart) {
      try {
        services.store.execute(moveArrangementClip(services.store.doc, current.clipId, drag.startBar));
      } catch {
        // overlap: dropped
      }
    }
    if (current.mode === "resize" && drag.lengthBars !== current.origLength) {
      try {
        services.store.execute(resizeArrangementClip(services.store.doc, current.clipId, drag.lengthBars));
      } catch {
        // overlap: dropped
      }
    }
  };

  const addClipAt = (bar: number) => {
    if (!selectedScene) return;
    try {
      services.store.execute(addArrangementClip(services.store.doc, selectedScene.id, bar, 4));
    } catch {
      // overlap: ignore
    }
  };

  return (
    <section className="arr-panel" aria-label="Arrangement and scenes">
      <div className="arr-scenes">
        <div className="arr-scenes-header">
          <h2 className="panel-title">SCENES</h2>
          <button
            type="button"
            className="btn btn-small"
            title="Create scene from active pattern"
            onClick={() => services.store.execute(createScene(services.store.doc))}
          >
            + SCENE
          </button>
        </div>
        <div className="scene-chips">
          {doc.scenes.map((scene) => {
            const pattern = doc.patterns.find((p) => p.id === scene.patternId);
            if (editingSceneId === scene.id) {
              return (
                <input
                  key={scene.id}
                  className="pattern-rename"
                  value={draft}
                  autoFocus
                  aria-label="Scene name"
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => {
                    if (draft.trim() !== "") {
                      services.store.execute(renameScene(services.store.doc, scene.id, draft.trim()));
                    }
                    setEditingSceneId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setEditingSceneId(null);
                  }}
                />
              );
            }
            const isSelected = selectedScene?.id === scene.id;
            const isActive = pattern?.id === doc.activePatternId;
            return (
              <div key={scene.id} className="scene-chip-wrap">
                <button
                  type="button"
                  className={`scene-chip${isSelected ? " selected" : ""}${isActive ? " active-pattern" : ""}`}
                  title={`${scene.name} → ${pattern?.name ?? "?"} — click to launch (sets active pattern)`}
                  onClick={() => {
                    setSelectedSceneId(scene.id);
                    services.store.execute(setActivePattern(services.store.doc, scene.patternId));
                  }}
                  onDoubleClick={() => {
                    setEditingSceneId(scene.id);
                    setDraft(scene.name);
                  }}
                >
                  {scene.name}
                </button>
                <button
                  type="button"
                  className="scene-delete"
                  title="Delete scene (and its clips)"
                  onClick={() => services.store.execute(deleteScene(services.store.doc, scene.id))}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="arr-timeline">
        <div className="arr-timeline-header">
          <h2 className="panel-title">ARRANGEMENT</h2>
          <div className="arr-timeline-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={!selectedScene}
              onClick={() => {
                if (!selectedScene) return;
                const lastEnd = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
                addClipAt(lastEnd);
              }}
            >
              + CLIP
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={selectedClipId === null}
              onClick={() =>
                selectedClipId && services.store.execute(duplicateArrangementClip(services.store.doc, selectedClipId))
              }
            >
              DUP
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={selectedClipId === null}
              onClick={() =>
                selectedClipId && services.store.execute(deleteArrangementClip(services.store.doc, selectedClipId))
              }
            >
              DEL
            </button>
          </div>
        </div>
        <div className="arr-lane-scroll">
          <div
            className="arr-lane"
            ref={laneRef}
            style={{ width: totalBars * BAR_WIDTH, height: LANE_HEIGHT }}
            onPointerDown={(event) => {
              if (event.target !== laneRef.current || event.button !== 0) return;
              addClipAt(barFromEvent(event));
              setSelectedClipId(null);
            }}
          >
            {Array.from({ length: totalBars }, (_, i) => (
              <div key={i} className={`arr-bar-grid${i % 4 === 0 ? " bar-strong" : ""}`} style={{ left: i * BAR_WIDTH }} />
            ))}
            {doc.arrangement.clips.map((clip) => {
              const scene = doc.scenes.find((s) => s.id === clip.sceneId);
              const isDragging = dragRef.current?.clipId === clip.id && drag !== null;
              const startBar = isDragging ? drag.startBar : clip.startBar;
              const lengthBars = isDragging ? drag.lengthBars : clip.lengthBars;
              const selected = selectedClipId === clip.id;
              return (
                <div
                  key={clip.id}
                  className={`arr-clip${selected ? " selected" : ""}`}
                  style={{ left: startBar * BAR_WIDTH, width: lengthBars * BAR_WIDTH - 4 }}
                  title={`${scene?.name ?? "?"} — bars ${startBar + 1}–${startBar + lengthBars} · drag to move, drag right edge to resize, right-click to delete`}
                  onPointerDown={(event) => {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const nearRightEdge = event.clientX > rect.right - 10;
                    beginClipDrag(event, clip.id, nearRightEdge ? "resize" : "move");
                  }}
                  onPointerMove={onClipPointerMove}
                  onPointerUp={onClipPointerUp}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    services.store.execute(deleteArrangementClip(services.store.doc, clip.id));
                    if (selectedClipId === clip.id) setSelectedClipId(null);
                  }}
                >
                  <span className="arr-clip-name">{scene?.name ?? "?"}</span>
                  <span className="arr-clip-bars">{lengthBars}b</span>
                  <span className="arr-clip-resize" />
                </div>
              );
            })}
          </div>
        </div>
        <div className="arr-hint">
          click empty lane to place <b>{selectedScene?.name ?? "scene"}</b> (4 bars) · clips play in SONG mode
        </div>
      </div>
    </section>
  );
}
