/**
 * MORPH DYNAMICS — Morph-scene state (A: Clean / B: Dense / C: Wide /
 * D: Destroyed) persisted on the effect's deviceState blob
 * (kind "morph-scenes-v1", sanitized in project-model/schema.ts).
 *
 * A scene is a full ENGINE parameter map: macros + dynamics + character +
 * motion + space + analysis sensitivity. Globals (I/O, mix, delta, quality)
 * and the mod-matrix wiring (routes.*) are deliberately excluded — a scene
 * changes how the processor BEHAVES, not how it is wired or how loud it is.
 */

import * as P from "./parameterIds.js";

export const MORPH_SCENES_KIND = "morph-scenes-v1";

export type MorphSceneSlot = "A" | "B" | "C" | "D";

export const MORPH_SCENE_SLOTS: readonly MorphSceneSlot[] = ["A", "B", "C", "D"];

export const MORPH_SCENE_LABELS: Record<MorphSceneSlot, string> = {
  A: "Clean",
  B: "Dense",
  C: "Wide",
  D: "Destroyed",
};

export interface MorphScenesState {
  slots: Partial<Record<MorphSceneSlot, Record<string, number>>>;
}

/** Extract the scene-capture subset from a full parameter map. */
export function pickSceneParams(params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(params)) {
    if (id.startsWith("global.") || id.startsWith("routes.")) continue;
    out[id] = value;
  }
  return out;
}

/** Read the sanitized deviceState blob into the panel's scene model. */
export function readMorphScenesState(
  deviceState?: { kind: string; data: Record<string, unknown> } | null,
): MorphScenesState | undefined {
  if (!deviceState || deviceState.kind !== MORPH_SCENES_KIND) return undefined;
  const raw = deviceState.data.slots;
  if (typeof raw !== "object" || raw === null) return undefined;
  const slots: MorphScenesState["slots"] = {};
  for (const slot of MORPH_SCENE_SLOTS) {
    const value = (raw as Record<string, unknown>)[slot];
    if (typeof value === "object" && value !== null) {
      slots[slot] = value as Record<string, number>;
    }
  }
  return { slots };
}

/**
 * Default scene presets — the four archetypes from FEATURES.md Tier 3,
 * expressed over the default device so a fresh install can morph
 * immediately without capturing anything first.
 */
export function defaultMorphScenes(): MorphScenesState {
  const base = {
    [P.MACRO_PUNCH_ID]: 20,
    [P.MACRO_BODY_ID]: 50,
    [P.MACRO_TEXTURE_ID]: 50,
    [P.DYN_THRESHOLD_DB_ID]: -24,
    [P.DYN_RATIO_ID]: 2.5,
    [P.DYN_ATTACK_MS_ID]: 12,
    [P.DYN_RELEASE_MS_ID]: 180,
    [P.CHAR_ENABLED_ID]: 1,
    [P.CHAR_DRIVE_ID]: 0,
    [P.CHAR_ASYM_ID]: 0,
    [P.CHAR_CLIP_ID]: 0,
    [P.MOTION_ENABLED_ID]: 1,
    [P.MOTION_DEPTH_ID]: 40,
    [P.MOTION_RATE_HZ_ID]: 0.2,
    [P.MOTION_FEEDBACK_ID]: 30,
    [P.SPACE_ENABLED_ID]: 1,
    [P.SPACE_SEND_ID]: 25,
    [P.SPACE_DECAY_S_ID]: 1.2,
    [P.SPACE_WIDTH_ID]: 115,
    [P.SPACE_DUCK_ID]: 50,
  };
  return {
    slots: {
      A: { ...base, [P.MACRO_PRESSURE_ID]: 15, [P.MACRO_MOTION_ID]: 0, [P.MACRO_SPACE_ID]: 10 },
      B: {
        ...base,
        [P.MACRO_PRESSURE_ID]: 60,
        [P.MACRO_MOTION_ID]: 15,
        [P.MACRO_SPACE_ID]: 25,
        [P.CHAR_DRIVE_ID]: 18,
        [P.CHAR_ASYM_ID]: 15,
        "dyn.ratio": 3.2,
      },
      C: {
        ...base,
        [P.MACRO_PRESSURE_ID]: 55,
        [P.MACRO_MOTION_ID]: 30,
        [P.MACRO_SPACE_ID]: 55,
        [P.SPACE_WIDTH_ID]: 165,
        [P.SPACE_DECAY_S_ID]: 2,
        [P.MOTION_DEPTH_ID]: 55,
      },
      D: {
        ...base,
        [P.MACRO_PRESSURE_ID]: 95,
        [P.MACRO_PUNCH_ID]: 50,
        [P.MACRO_BODY_ID]: 75,
        [P.MACRO_TEXTURE_ID]: 75,
        [P.MACRO_MOTION_ID]: 70,
        [P.MACRO_SPACE_ID]: 60,
        [P.CHAR_DRIVE_ID]: 35,
        [P.CHAR_ASYM_ID]: 30,
        [P.CHAR_CLIP_ID]: 25,
        [P.MOTION_DEPTH_ID]: 60,
        [P.MOTION_RATE_HZ_ID]: 0.8,
        [P.MOTION_FEEDBACK_ID]: 55,
        [P.SPACE_SEND_ID]: 45,
        [P.SPACE_DECAY_S_ID]: 3,
        [P.SPACE_WIDTH_ID]: 150,
        [P.SPACE_DUCK_ID]: 90,
      },
    },
  };
}
