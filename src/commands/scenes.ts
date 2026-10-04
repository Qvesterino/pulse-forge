/**
 * Scene lifecycle: create, duplicate-as-variation, role, reorder, rename, pattern
 * binding and delete.
 *
 * `makeSceneVariation` is exported for the arrangement layer, which places a freshly
 * built variation onto the timeline. It is deliberately NOT re-exported by the barrel,
 * so the public surface does not grow by one name.
 */
import type { Command } from "./types";
import type { ProjectDocument, Scene, SceneRole } from "../project-model/types";
import { patternLetter, sceneRoleOf } from "../project-model/schema";
import type { Pattern } from "../project-model/types";
import { uid } from "../shared/ids";
import { snapshot } from "./core";
import { cloneStepMeta, markerClampPatch } from "./docOps";

/* ---------------- scenes ---------------- */

export function createScene(doc: ProjectDocument, name?: string): Command {
  const scene: Scene = {
    id: uid("scene"),
    name: name ?? `Scene ${patternLetter(doc.scenes.length)}`,
    patternId: doc.activePatternId,
    intensity: 0.7,
  };
  const next: ProjectDocument = { ...doc, scenes: [...doc.scenes, scene] };
  return snapshot("createScene", `Add ${scene.name}`, doc, next);
}

function uniqueVariationName(doc: ProjectDocument, sourceName: string): string {
  const base = `${sourceName} VAR`;
  let index = 1;
  while (
    doc.scenes.some((scene) => scene.name.toLowerCase() === `${base} ${String(index).padStart(2, "0")}`.toLowerCase())
  ) {
    index += 1;
  }
  return `${base} ${String(index).padStart(2, "0")}`;
}

function clonePatternForVariation(source: Pattern, sourceName: string): Pattern {
  return {
    ...source,
    id: uid("pattern"),
    name: `${sourceName} Variation`,
    rows: Object.fromEntries(Object.entries(source.rows).map(([id, row]) => [id, [...row]])),
    // Fresh note ids + deep-cloned stepMeta (Audit 08 D8): duplicated ids
    // across two patterns on the same track could match the wrong notes in
    // SelectionStore, and shared `locks` object references aliased the
    // source pattern's performance state.
    notes: Object.fromEntries(
      Object.entries(source.notes ?? {}).map(([id, notes]) => [
        id,
        notes.map((note) => ({ ...note, id: uid("note") })),
      ]),
    ),
    stepMeta: source.stepMeta ? cloneStepMeta(source.stepMeta) : undefined,
    generation: source.generation ? { ...source.generation, sourcePatternId: source.id } : undefined,
  };
}

export function makeSceneVariation(
  doc: ProjectDocument,
  source: Scene,
  roleOverride?: SceneRole,
): { scene: Scene; pattern: Pattern } {
  const sourcePattern = doc.patterns.find((pattern) => pattern.id === source.patternId);
  if (!sourcePattern) throw new Error(`Pattern ${source.patternId} not found`);
  const name = uniqueVariationName(doc, source.name);
  const pattern = clonePatternForVariation(sourcePattern, name);
  const scene: Scene = {
    ...source,
    id: uid("scene"),
    name,
    patternId: pattern.id,
    intensityCurve: source.intensityCurve?.map((point) => ({ ...point })),
    role: roleOverride ?? source.role ?? sceneRoleOf(source),
  };
  return { scene, pattern };
}

export function duplicateSceneAsVariation(doc: ProjectDocument, sceneId: string, roleOverride?: SceneRole): Command {
  const source = doc.scenes.find((scene) => scene.id === sceneId);
  if (!source) throw new Error(`Scene ${sceneId} not found`);
  const { scene, pattern } = makeSceneVariation(doc, source, roleOverride);
  const next: ProjectDocument = {
    ...doc,
    patterns: [...doc.patterns, pattern],
    scenes: [...doc.scenes, scene],
  };
  return snapshot("duplicateSceneAsVariation", `Create variation ${scene.name}`, doc, next);
}

export function setSceneRole(doc: ProjectDocument, sceneId: string, role: SceneRole | null): Command {
  const target = doc.scenes.find((scene) => scene.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  const next: ProjectDocument = {
    ...doc,
    scenes: doc.scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      if (role) return { ...scene, role };
      const { role: _role, ...withoutRole } = scene;
      return withoutRole;
    }),
  };
  return snapshot("setSceneRole", role ? `Set ${target.name} role to ${role}` : `Clear ${target.name} role`, doc, next);
}

export function reorderScenes(doc: ProjectDocument, fromIndex: number, toIndex: number): Command {
  if (fromIndex < 0 || fromIndex >= doc.scenes.length || toIndex < 0 || toIndex >= doc.scenes.length) {
    throw new Error("Scene reorder index out of range");
  }
  if (fromIndex === toIndex) return snapshot("reorderScenes", "Reorder scenes", doc, doc);
  const scenes = [...doc.scenes];
  const [moved] = scenes.splice(fromIndex, 1);
  scenes.splice(toIndex, 0, moved);
  return snapshot("reorderScenes", "Reorder scenes", doc, { ...doc, scenes });
}

export function renameScene(doc: ProjectDocument, sceneId: string, name: string): Command {
  const prev = doc.scenes.find((s) => s.id === sceneId)?.name ?? "";
  return {
    type: "renameScene",
    label: `Rename scene to "${name}"`,
    execute: (d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, name } : s)) }),
    undo: (d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, name: prev } : s)) }),
  };
}

export function setScenePattern(doc: ProjectDocument, sceneId: string, patternId: string): Command {
  const prev = doc.scenes.find((s) => s.id === sceneId)?.patternId ?? "";
  const apply = (d: ProjectDocument, v: string): ProjectDocument => ({
    ...d,
    scenes: d.scenes.map((s) => (s.id === sceneId ? { ...s, patternId: v } : s)),
  });
  return {
    type: "setScenePattern",
    label: "Set scene pattern",
    execute: (d) => apply(d, patternId),
    undo: (d) => apply(d, prev),
  };
}

export function deleteScene(doc: ProjectDocument, sceneId: string): Command {
  if (doc.scenes.length <= 1) throw new Error("Cannot delete the last scene");
  const target = doc.scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error(`Scene ${sceneId} not found`);
  // Audit 08 D1: the scene's automation lanes must be pruned IN-COMMAND —
  // normalize strips them post-apply, so undo restored the scene but its
  // lanes were permanently gone (deleteTrack bug class).
  const sceneAutomation = doc.sceneAutomation?.filter((lane) => lane.sceneId !== sceneId);
  const remainingScenes = doc.scenes.filter((s) => s.id !== sceneId);
  const remainingClips = doc.arrangement.clips.filter((c) => c.sceneId !== sceneId);
  const next: ProjectDocument = {
    ...doc,
    scenes: remainingScenes,
    ...(sceneAutomation ? { sceneAutomation } : {}),
    // Audit 08 D3: markers clamp to the shrunken project end in-command.
    ...markerClampPatch(doc.markers, remainingScenes, doc.patterns, {
      ...doc.arrangement,
      clips: remainingClips,
    }),
    arrangement: {
      ...doc.arrangement,
      clips: remainingClips,
      transitions: doc.arrangement.transitions?.filter((transition) => {
        const clipIds = new Set(remainingClips.map((clip) => clip.id));
        return clipIds.has(transition.fromClipId) && clipIds.has(transition.toClipId);
      }),
    },
  };
  return snapshot("deleteScene", `Delete scene ${target.name}`, doc, next);
}
