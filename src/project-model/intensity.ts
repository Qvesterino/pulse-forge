import type { Scene } from "./types";

/**
 * Compute the scene's intensity value at a given scene-local tick. Uses a
 * piecewise-linear interpolation of `scene.intensityCurve` if present,
 * otherwise the static `scene.intensity`. Returns 0 outside the scene's span.
 */
export function computeSceneIntensity(scene: Scene, sceneStartTick: number, currentTick: number): number {
  // Outside the scene's window we emit 0 so bindings don't leak between clips.
  if (currentTick < sceneStartTick) return 0;
  const curve = scene.intensityCurve;
  const fallback = clamp01(scene.intensity);
  if (!curve || curve.length === 0) {
    return fallback;
  }
  const offset = currentTick - sceneStartTick;
  if (offset <= curve[0].offset) {
    return clamp01(curve[0].value);
  }
  if (offset >= curve[curve.length - 1].offset) {
    return clamp01(curve[curve.length - 1].value);
  }
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (offset >= a.offset && offset <= b.offset) {
      const span = b.offset - a.offset;
      if (span <= 0) return clamp01(a.value);
      const t = (offset - a.offset) / span;
      return clamp01(a.value + (b.value - a.value) * t);
    }
  }
  return fallback;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.max(0, Math.min(1, v));
}

/** Convenience: look up a scene's intensity at a given absolute project tick, or
 *  fall back to the project-wide default if the scene is not currently active. */
export function intensitySignalAt(
  doc: { scenes: Scene[]; arrangement: { clips: { id: string; sceneId: string; startBar: number; lengthBars: number }[] } },
  activePatternId: string,
  tick: number,
): number {
  // The active scene is whichever arrangement clip the tick falls within.
  for (const clip of doc.arrangement.clips) {
    const start = clip.startBar * 1920;
    const end = start + clip.lengthBars * 1920;
    if (tick >= start && tick < end) {
      const scene = doc.scenes.find((s) => s.patternId === activePatternId) ?? doc.scenes.find((s) => s.id === clip.sceneId);
      if (scene) return computeSceneIntensity(scene, start, tick);
    }
  }
  // Pattern-mode fallback: use the active scene (if any) at offset 0.
  const active = doc.scenes.find((s) => s.patternId === activePatternId);
  if (active) return clamp01(active.intensity);
  return 0.7;
}
