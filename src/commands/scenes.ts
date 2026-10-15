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

/**
 * Per-scene scene-pack selection (v23): which pack pair a TWIST/GROW effect
 * plays while this scene is active. The engine applies it as a live override
 * at clip boundaries; the doc keeps the effect's own applied pair as the
 * stopped-state baseline. Pair ids are shape-checked here only — an unknown
 * id is inert (the engine cannot resolve it), and validating against the
 * packs would drag ~8 KB of pack data into the eager command barrel.
 */
export function setScenePack(doc: ProjectDocument, sceneId: string, fxId: string, pairId: string | null): Command {
  const scene = doc.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  const fx = doc.tracks.flatMap((track) => ("effects" in track ? track.effects : [])).find((e) => e.id === fxId);
  if (!fx || (fx.type !== "skrutka" && fx.type !== "bassHarmonic")) {
    throw new Error(`Effect ${fxId} is not a scene-pack effect`);
  }
  if (pairId !== null && (typeof pairId !== "string" || pairId.length === 0 || pairId.length > 64)) {
    throw new Error("Invalid scene pair id");
  }
  const apply = (d: ProjectDocument, value: string | null): ProjectDocument => ({
    ...d,
    scenes: d.scenes.map((candidate) => {
      if (candidate.id !== sceneId) return candidate;
      const packs = { ...(candidate.packs ?? {}) };
      if (value === null) delete packs[fxId];
      else packs[fxId] = value;
      const next = Object.keys(packs).length > 0 ? packs : undefined;
      return { ...candidate, packs: next };
    }),
  });
  return snapshot(
    "setScenePack",
    pairId === null ? `Clear ${scene.name} scene pair` : `Set ${scene.name} scene pair`,
    doc,
    apply(doc, pairId),
  );
}

/**
 * Per-scene macro pin (v24): the value a macro plays while this scene is
 * active — it substitutes the live macro value in every macro-sourced
 * mapping (live + exports); the doc keeps its own macro value as the
 * stopped-state baseline. `null` clears the pin.
 */
export function setSceneMacro(doc: ProjectDocument, sceneId: string, macroId: string, value: number | null): Command {
  const scene = doc.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  if (!doc.macros.some((macro) => macro.id === macroId)) throw new Error(`Macro ${macroId} not found`);
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("Invalid scene macro value");
  }
  const clamped = value === null ? null : Math.min(1, Math.max(0, value));
  const apply = (d: ProjectDocument, nextValue: number | null): ProjectDocument => ({
    ...d,
    scenes: d.scenes.map((candidate) => {
      if (candidate.id !== sceneId) return candidate;
      const macros = { ...(candidate.macros ?? {}) };
      if (nextValue === null) delete macros[macroId];
      else macros[macroId] = nextValue;
      const next = Object.keys(macros).length > 0 ? macros : undefined;
      return { ...candidate, macros: next };
    }),
  });
  return snapshot(
    "setSceneMacro",
    clamped === null ? `Clear ${scene.name} macro pin` : `Pin macro to ${scene.name}`,
    doc,
    apply(doc, clamped),
  );
}

/**
 * Per-scene MIDI-CC remap arming (v25): the source:"midiCC" mappings that
 * stay armed while this scene is active. Absent list = all armed (the
 * pre-scene behavior); empty = none; otherwise an allow-list. Canonicalized:
 * a list that covers every CC mapping collapses back to "all armed". The
 * gate is live-only (hardware CC never reaches an export).
 */
export function setSceneCcRemap(doc: ProjectDocument, sceneId: string, mappingId: string, active: boolean): Command {
  const scene = doc.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  const isCcMapping = doc.macros.some((macro) =>
    macro.mappings.some((mapping) => mapping.id === mappingId && mapping.source === "midiCC"),
  );
  if (!isCcMapping) throw new Error(`Mapping ${mappingId} is not a MIDI CC mapping`);
  const allIds = doc.macros.flatMap((macro) =>
    macro.mappings.filter((mapping) => mapping.source === "midiCC").map((mapping) => mapping.id),
  );
  const current = scene.ccRemaps;
  const currentlyActive = current === undefined || current.includes(mappingId);
  let next: string[] | undefined = current;
  if (active && !currentlyActive) {
    const merged = [...new Set([...(current ?? []), mappingId])];
    next = allIds.every((id) => merged.includes(id)) ? undefined : merged;
  } else if (!active && currentlyActive) {
    const remaining = (current ?? allIds).filter((id) => id !== mappingId);
    next = remaining.length === 0 ? [] : remaining;
  }
  const apply = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    scenes: d.scenes.map((candidate) => (candidate.id === sceneId ? { ...candidate, ccRemaps: next } : candidate)),
  });
  return snapshot(
    "setSceneCcRemap",
    active ? `Arm CC mapping in ${scene.name}` : `Disarm CC mapping in ${scene.name}`,
    doc,
    apply(doc),
  );
}

/**
 * Per-scene MIDI-CC re-point (v29): while this scene is active the mapping
 * LISTENS on the overridden channel / CC number instead of its own.
 * `patch` carries only the fields being changed; `null` clears a field back
 * to the mapping's own value. Canonicalizing: a field equal to the mapping's
 * own value is dropped, an empty entry vanishes, an empty record collapses
 * to absent — typing the base value back IS the clear gesture.
 */
export function setSceneCcOverride(
  doc: ProjectDocument,
  sceneId: string,
  mappingId: string,
  patch: { ccNumber?: number | null; channel?: number | null },
): Command {
  const scene = doc.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  const mapping = doc.macros.flatMap((macro) => macro.mappings).find((m) => m.id === mappingId && m.source === "midiCC");
  if (!mapping) throw new Error(`Mapping ${mappingId} is not a MIDI CC mapping`);
  if (patch.ccNumber != null) {
    if (!Number.isInteger(patch.ccNumber) || patch.ccNumber < 0 || patch.ccNumber > 127) {
      throw new Error("Invalid CC number");
    }
  }
  if (patch.channel != null) {
    if (!Number.isInteger(patch.channel) || patch.channel < 1 || patch.channel > 16) {
      throw new Error("Invalid MIDI channel");
    }
  }
  const entry: { ccNumber?: number; channel?: number } = { ...(scene.ccOverrides?.[mappingId] ?? {}) };
  if (patch.ccNumber !== undefined) {
    if (patch.ccNumber === null) delete entry.ccNumber;
    else entry.ccNumber = patch.ccNumber;
  }
  if (patch.channel !== undefined) {
    if (patch.channel === null) delete entry.channel;
    else entry.channel = patch.channel;
  }
  // Canonicalize against the mapping's own values.
  if (entry.ccNumber === mapping.ccNumber) delete entry.ccNumber;
  if (entry.channel === mapping.channel) delete entry.channel;
  const overrides = { ...(scene.ccOverrides ?? {}) };
  if (entry.ccNumber !== undefined || entry.channel !== undefined) overrides[mappingId] = entry;
  else delete overrides[mappingId];
  const next = Object.keys(overrides).length > 0 ? overrides : undefined;
  const apply = (d: ProjectDocument): ProjectDocument => ({
    ...d,
    scenes: d.scenes.map((candidate) =>
      candidate.id === sceneId ? { ...candidate, ccOverrides: next } : candidate,
    ),
  });
  return snapshot("setSceneCcOverride", `Scene CC re-point in ${scene.name}`, doc, apply(doc));
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
