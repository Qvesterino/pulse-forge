import type { Scene } from "./types";

/**
 * SCENE PERFORMANCE — the per-scene performance context a scheduler window
 * hands to the engine: which pack pairs play, which macro values are pinned
 * and which MIDI-CC remaps are armed (optionally re-pointed to another
 * channel / CC number). One shape, used by the live pattern call, the
 * song-window points and the offline renderer's point builder, so every
 * consumer sees the scene arc identically.
 *
 * `scenePerformanceOf(scene)` normalizes a scene into that shape: fields are
 * attached only when non-empty, so an absent field always means "play the
 * document state".
 */

/** Per-scene re-point of one source:"midiCC" mapping. */
export interface SceneCcOverride {
  /** Listen on this CC number instead of the mapping's own. */
  ccNumber?: number;
  /** Listen on this channel instead of the mapping's filter (absent = any). */
  channel?: number;
}

/** Per-scene pattern swap for one schedulable (step / random) modulator. */
export interface SceneModulatorPattern {
  /** Replacement step pattern (step kind; bipolar −1..1 entries). */
  steps?: number[];
  /** Replacement random seed (random/S&H kind). */
  seed?: string;
}

export interface ScenePerformance {
  /** fxId → scene-pack pair id (TWIST/GROW). */
  packs?: Record<string, string> | null;
  /** macroId → pinned 0..1 value. */
  sceneMacros?: Record<string, number> | null;
  /** source:"midiCC" mapping ids armed while the scene plays. */
  ccRemaps?: string[] | null;
  /** mappingId → channel/CC re-point overrides. */
  ccOverrides?: Record<string, SceneCcOverride> | null;
  /** lfoId → pinned modulation pattern (steps / seed). */
  modulators?: Record<string, SceneModulatorPattern> | null;
}

/** Normalize a scene's performance context (null when the scene carries none). */
export function scenePerformanceOf(scene: Scene | null | undefined): ScenePerformance | null {
  if (!scene) return null;
  const performance: ScenePerformance = {};
  if (scene.packs && Object.keys(scene.packs).length > 0) performance.packs = scene.packs;
  if (scene.macros && Object.keys(scene.macros).length > 0) performance.sceneMacros = scene.macros;
  if (scene.ccRemaps && scene.ccRemaps.length > 0) performance.ccRemaps = scene.ccRemaps;
  if (scene.ccOverrides && Object.keys(scene.ccOverrides).length > 0) performance.ccOverrides = scene.ccOverrides;
  if (scene.modulators && Object.keys(scene.modulators).length > 0) performance.modulators = scene.modulators;
  return Object.keys(performance).length > 0 ? performance : null;
}
