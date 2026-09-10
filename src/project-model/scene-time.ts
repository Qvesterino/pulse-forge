import { BAR_TICKS, PPQ } from "./types";

/**
 * Wall-clock (seconds) helpers for Scene Mode (VISION §10): a producer thinks
 * "this scene lasts 32 seconds", not "16 bars". Seconds are an AUTHORING and
 * DISPLAY affordance — the persisted model stays bar-based, converted at the
 * scene's EFFECTIVE tempo (its own BPM pin, else the project tempo) so the
 * numbers stay honest when a scene pins a different tempo.
 */

/** The tempo a scene runs at — its own BPM pin, else the project tempo. */
export function effectiveSceneBpm(sceneBpm: number | undefined, projectBpm: number): number {
  if (sceneBpm !== undefined && Number.isFinite(sceneBpm) && sceneBpm > 0) return sceneBpm;
  return projectBpm;
}

/** Wall-clock seconds a span of `bars` bars lasts at `bpm`. */
export function sceneBarsToSeconds(bars: number, bpm: number): number {
  return (bars * BAR_TICKS * 60) / (bpm * PPQ);
}

/** Bars (fractional) needed for `seconds` of wall-clock time at `bpm`. */
export function sceneSecondsToBars(seconds: number, bpm: number): number {
  return (seconds * bpm * PPQ) / (BAR_TICKS * 60);
}
