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

/**
 * The tempo the transport runs at while the playhead is over arrangement
 * `tick`: the BPM pin of the scene whose clip covers the tick, else the
 * project tempo (gaps run at the project tempo). This mirrors the scheduler's
 * active-scene resolution — audio-clip edit math (split offsets, trim deltas,
 * warp-pin placement) must convert bars↔seconds at the SAME tempo playback
 * uses, or the written source offsets drift against the audible result.
 */
export function tempoAtTick(
  clips: ReadonlyArray<{ sceneId: string; startBar: number; lengthBars: number }>,
  scenes: ReadonlyArray<{ id: string; bpm?: number }>,
  tick: number,
  projectBpm: number,
): number {
  const bar = tick / BAR_TICKS;
  const covering = clips.find(
    (clip) =>
      Number.isFinite(clip.startBar) &&
      Number.isFinite(clip.lengthBars) &&
      bar >= clip.startBar &&
      bar < clip.startBar + clip.lengthBars,
  );
  if (!covering) return projectBpm;
  const scene = scenes.find((candidate) => candidate.id === covering.sceneId);
  return effectiveSceneBpm(scene?.bpm, projectBpm);
}

/**
 * Piecewise wall-clock seconds between two arrangement ticks, integrating the
 * effective scene tempo over the span (scene-pinned spans at their pin, gaps
 * at the project tempo). Signed: `toTick < fromTick` returns the negated
 * integral of the reversed span. The audio-comp command (compAudioTakeRange)
 * walks the same map — this is the shared form so split/trim math cannot
 * diverge from it again.
 */
export function arrangementSecondsBetweenTicks(
  clips: ReadonlyArray<{ sceneId: string; startBar: number; lengthBars: number }>,
  scenes: ReadonlyArray<{ id: string; bpm?: number }>,
  fromTick: number,
  toTick: number,
  projectBpm: number,
): number {
  if (!Number.isFinite(fromTick) || !Number.isFinite(toTick) || fromTick === toTick) return 0;
  if (toTick < fromTick) return -arrangementSecondsBetweenTicks(clips, scenes, toTick, fromTick, projectBpm);
  // Scene spans as tick ranges, sorted so the walk hits boundaries in order.
  const spans = clips
    .filter((clip) => Number.isFinite(clip.startBar) && Number.isFinite(clip.lengthBars) && clip.lengthBars > 0)
    .map((clip) => ({
      from: clip.startBar * BAR_TICKS,
      to: (clip.startBar + clip.lengthBars) * BAR_TICKS,
      bpm: effectiveSceneBpm(scenes.find((scene) => scene.id === clip.sceneId)?.bpm, projectBpm),
    }))
    .filter((span) => span.to > span.from)
    .sort((a, b) => a.from - b.from);
  const epsilon = 1e-6;
  let cursor = fromTick;
  let seconds = 0;
  // Walk span-boundary to span-boundary; anything not covered by a scene span
  // runs at the project tempo, exactly like the scheduler's applyTempo(null).
  while (cursor < toTick - epsilon) {
    const active = spans.find((span) => cursor >= span.from && cursor < span.to);
    const nextBoundary = active
      ? Math.min(toTick, active.to)
      : Math.min(toTick, ...spans.filter((span) => span.from > cursor).map((span) => span.from));
    seconds += (nextBoundary - cursor) * (60 / ((active ? active.bpm : projectBpm) * PPQ));
    cursor = nextBoundary;
  }
  return seconds;
}
