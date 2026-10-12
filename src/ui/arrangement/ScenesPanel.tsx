import type { ReactElement } from "react";
import { SceneLauncher } from "../SceneLauncher";
import { SceneStrip } from "../SceneStrip";
import { sceneRoleOf } from "../../project-model/schema";
import type { Scene, SceneRole } from "../../project-model/types";

/**
 * Arrangement collaborator 3/4 — the SCENES strip: create, duplicate pattern,
 * create variation, select / rename / delete / reorder, scene role, and the
 * FILL / DROP / BREAK role variations.
 *
 * Extracted verbatim from ArrangementPanel. Pure renderer: every verb below
 * reaches the project through a shell-owned command callback, so this module
 * never touches the doc, the store, or the command bus.
 */

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

export interface ScenesPanelProps {
  selectedScene: Scene | undefined;
  currentClipId: string | null;
  onCreateScene: () => void;
  onDuplicatePattern: (scene: Scene) => void;
  onCreateVariation: (scene: Scene) => void;
  onSelectScene: (scene: Scene) => void;
  onRenameScene: (scene: Scene, name: string) => void;
  onDeleteScene: (scene: Scene) => void;
  onReorderScenes: (fromIndex: number, toIndex: number) => void;
  onSetSceneRole: (sceneId: string, role: SceneRole | null) => void;
  onCreateRoleVariation: (role: "fill" | "drop" | "break") => void;
}

export function ScenesPanel(props: ScenesPanelProps): ReactElement {
  const {
    selectedScene,
    currentClipId,
    onCreateScene,
    onDuplicatePattern,
    onCreateVariation,
    onSelectScene,
    onRenameScene,
    onDeleteScene,
    onReorderScenes,
    onSetSceneRole,
    onCreateRoleVariation,
  } = props;
  return (
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
          onClick={onCreateScene}
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
          onClick={() => selectedScene && onDuplicatePattern(selectedScene)}
        >
          DUP PATTERN
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!selectedScene}
          title="Create a variation scene: new scene + varied copy of the pattern"
          onClick={() => selectedScene && onCreateVariation(selectedScene)}
        >
          VARIATION
        </button>
      </div>
      <SceneStrip sceneId={selectedScene?.id} />
      <SceneLauncher
        variant="panel"
        currentClipId={currentClipId}
        selectedSceneId={selectedScene?.id}
        onSelectScene={onSelectScene}
        onRenameScene={onRenameScene}
        onDeleteScene={onDeleteScene}
        onReorderScenes={onReorderScenes}
        onDuplicatePattern={onDuplicatePattern}
      />
      {selectedScene && (
        <label className="arr-scene-role">
          ROLE
          <select
            value={selectedScene.role ?? sceneRoleOf(selectedScene) ?? ""}
            onChange={(event) => onSetSceneRole(selectedScene.id, (event.target.value || null) as SceneRole | null)}
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
          onClick={() => onCreateRoleVariation("fill")}
        >
          FILL
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!selectedScene}
          onClick={() => onCreateRoleVariation("drop")}
        >
          DROP
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!selectedScene}
          onClick={() => onCreateRoleVariation("break")}
        >
          BREAK
        </button>
      </div>
    </div>
  );
}
