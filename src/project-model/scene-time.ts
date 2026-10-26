import { PPQ } from "./types";

/**
 * Wall-clock (seconds) helpers for Scene Mode (VISION §10): a producer thinks
 * "this scene lasts 32 seconds", not "16 bars". Seconds are an AUTHORING and
 * DISPLAY affordance — the persisted model stays bar-based, converted at the
 * scene's EFFECTIVE tempo (its own BPM pin, else the project tempo) so the
 * numbers stay honest when a scene pins a different tempo.
 *
 * `barUnitTicks` is the document's bar length in ticks (ADR 0056). It is a
 * required argument, never a default: a default would keep every scene
 * measured in 4/4 bars while the document says 6/8.
 */

/** The tempo a scene runs at — its own BPM pin, else the project tempo. */
export function effectiveSceneBpm(sceneBpm: number | undefined, projectBpm: number): number {
  if (sceneBpm !== undefined && Number.isFinite(sceneBpm) && sceneBpm > 0) return sceneBpm;
  return projectBpm;
}

/** Wall-clock seconds a span of `bars` bars lasts at `bpm`. */
export function sceneBarsToSeconds(bars: number, bpm: number, barUnitTicks: number): number {
  return (bars * barUnitTicks * 60) / (bpm * PPQ);
}

/** Bars (fractional) needed for `seconds` of wall-clock time at `bpm`. */
export function sceneSecondsToBars(seconds: number, bpm: number, barUnitTicks: number): number {
  return (seconds * bpm * PPQ) / (barUnitTicks * 60);
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
  barUnitTicks: number,
): number {
  const bar = tick / barUnitTicks;
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
/**
 * One scene-pinned span of the arrangement, in ticks, with its effective tempo.
 */
export interface ArrangementSpan {
  from: number;
  to: number;
  bpm: number;
}

/**
 * THE SPAN MAP — the arrangement's scene spans, sorted, built ONCE.
 *
 * The arrangement render asked for the wall-clock length of EVERY visible
 * audio clip, and each of those questions rebuilt the whole span map: a filter
 * over every scene clip, a `scenes.find` per clip, and a sort — per visible
 * clip. With W visible clips and N scene clips that is O(W × (N + N·S + N log N))
 * per render (performance-cliff audit, finding C-3).
 *
 * The map is derived from the clip list, so it is built once per list — the
 * ADR 0063 pattern: build the index once, outside the loop, and invalidate it
 * by identity (the caller's `useMemo` keys it on the list).
 *
 * `scenes` is indexed by id, first match wins (ADR 0063's rule) so the answer
 * is identical to the `scenes.find` this replaced.
 */
export function buildArrangementSpans(
  clips: ReadonlyArray<{ sceneId: string; startBar: number; lengthBars: number }>,
  scenes: ReadonlyArray<{ id: string; bpm?: number }>,
  projectBpm: number,
  barUnitTicks: number,
): ArrangementSpan[] {
  const sceneBpm = new Map<string, number | undefined>();
  for (const scene of scenes) {
    if (!sceneBpm.has(scene.id)) sceneBpm.set(scene.id, scene.bpm);
  }
  return clips
    .filter((clip) => Number.isFinite(clip.startBar) && Number.isFinite(clip.lengthBars) && clip.lengthBars > 0)
    .map((clip) => ({
      from: clip.startBar * barUnitTicks,
      to: (clip.startBar + clip.lengthBars) * barUnitTicks,
      bpm: effectiveSceneBpm(sceneBpm.get(clip.sceneId), projectBpm),
    }))
    .filter((span) => span.to > span.from)
    .sort((a, b) => a.from - b.from);
}

/**
 * The walk, over an ALREADY BUILT span map.
 *
 * The spans are sorted by `from`, so the next boundary after the cursor is the
 * FIRST span that starts later — the scan stops there. The old code found it
 * with `Math.min(toTick, ...spans.filter(...).map(...))`, which allocated two
 * arrays per step and spread them into `Math.min` (a call-stack overflow once
 * the arrangement grew past ~100k spans).
 */
export function arrangementSecondsBetweenTicksInSpans(
  spans: readonly ArrangementSpan[],
  fromTick: number,
  toTick: number,
  projectBpm: number,
): number {
  if (!Number.isFinite(fromTick) || !Number.isFinite(toTick) || fromTick === toTick) return 0;
  if (toTick < fromTick) return -arrangementSecondsBetweenTicksInSpans(spans, toTick, fromTick, projectBpm);
  const epsilon = 1e-6;
  let cursor = fromTick;
  let seconds = 0;
  // Walk span-boundary to span-boundary; anything not covered by a scene span
  // runs at the project tempo, exactly like the scheduler's applyTempo(null).
  while (cursor < toTick - epsilon) {
    const active = spans.find((span) => cursor >= span.from && cursor < span.to);
    let nextStart = toTick;
    for (const span of spans) {
      if (span.from > cursor) {
        nextStart = span.from;
        break;
      }
    }
    const nextBoundary = active ? Math.min(toTick, active.to) : Math.min(toTick, nextStart);
    seconds += (nextBoundary - cursor) * (60 / ((active ? active.bpm : projectBpm) * PPQ));
    cursor = nextBoundary;
  }
  return seconds;
}

/**
 * Piecewise wall-clock seconds between two arrangement ticks, integrating the
 * effective scene tempo over the span (scene-pinned spans at their pin, gaps
 * at the project tempo). Signed: `toTick < fromTick` returns the negated
 * integral of the reversed span. The audio-comp command (compAudioTakeRange)
 * walks the same map — this is the shared form so split/trim math cannot
 * diverge from it again.
 *
 * This is the CONVENIENCE form: it builds the span map and then walks it. A
 * caller that asks the question many times over the same clip list — the
 * arrangement render, once per visible audio clip — should build the map once
 * with `buildArrangementSpans` and call `arrangementSecondsBetweenTicksInSpans`.
 */
export function arrangementSecondsBetweenTicks(
  clips: ReadonlyArray<{ sceneId: string; startBar: number; lengthBars: number }>,
  scenes: ReadonlyArray<{ id: string; bpm?: number }>,
  fromTick: number,
  toTick: number,
  projectBpm: number,
  barUnitTicks: number,
): number {
  if (!Number.isFinite(fromTick) || !Number.isFinite(toTick) || fromTick === toTick) return 0;
  return arrangementSecondsBetweenTicksInSpans(
    buildArrangementSpans(clips, scenes, projectBpm, barUnitTicks),
    fromTick,
    toTick,
    projectBpm,
  );
}
