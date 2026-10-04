/**
 * SMART COMP PLANNER — decide, bar by bar, which source take should feed the
 * comp, and prove it.
 *
 * `compAudioTakeRange` (commands.ts) already does the hard, verified part: it
 * replaces an arrangement-tick range in the comp with material from one
 * source take, non-destructively, with crossfades at the seams. What it asks
 * the user for — and what the user cannot honestly judge without hours of
 * listening — is WHICH take per range.
 *
 * This planner answers it from measurable evidence:
 *
 *   1. every take in the group is measured (`measureTake`) over the whole
 *      recorded pass — the metrics are stable, not bar-local noise;
 *   2. the group's timeline span (union of the takes' clips) is divided into
 *      1-bar windows;
 *   3. for each window, the take with the best score WINS, BUT windows that
 *      the winning take does not cover are handed to the next-best take that
 *      does — a take with a hole in the middle must not create a silent comp;
 *   4. adjacent windows with the same winner MERGE into one range, because
 *      every seam is a crossfade the producer will hear. Fewer seams is a
 *      feature, and it is measurable: `segments` in the plan is exactly the
 *      number of comp commands that will be dispatched.
 *
 * SCOPE — how this relates to the existing `src/vocal/comping.ts`:
 *
 * That module plans a comp from MEASURED `VocalProfile`s for the vocal
 * recording lane (IntentPanel), scoring phrase energy / SNR. It operates on
 * already-extracted profile objects, not audio. This module is the
 * ARRANGEMENT take-lane counterpart: it measures the audio itself
 * (groove lock, pitch drift, noise floor, clipping) and plans over
 * `arrangement.audioClips` take groups so the result is directly installable
 * by `compAudioTakeRange`. The two plan DIFFERENT lanes (vocal-lane profiles
 * vs any linear audio take group) and share no scoring code; if they are ever
 * unified it should be at the metric layer, not the plan layer.
 *
 * Honesty rules:
 *   - a take only competes for windows it actually covers (clip coverage is
 *     resolved via the same linear/forward rules `compAudioTakeRange` will
 *     enforce — planning must never propose a command the executor refuses);
 *   - a window NO take covers is reported as `uncoveredBars`, never silently
 *     dropped: the UI must tell the user the comp has holes;
 *   - the planner is pure and deterministic — same takes + same doc, same
 *     plan. It never touches the store; applying the plan is one layered
 *     command (see commands.ts `applySmartComp`).
 */

import { scoreTake, measureTake, type TakeScore } from "../audio-engine/take-scoring";
import type { AudioClip, AudioTakeGroup, ProjectDocument } from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";
import { compAudioTakeRange } from "./commands";
import type { Command } from "./types";

/** A contiguous range of bars assigned to one source take. */
export interface CompSegment {
  sourceTakeId: string;
  /** Inclusive start bar. */
  startBar: number;
  /** Exclusive end bar. */
  endBar: number;
}

/** The full plan the UI previews and the command layer applies. */
export interface SmartCompPlan {
  /** Merged ranges in timeline order. Empty when the group is not compable. */
  segments: CompSegment[];
  /** Bars in the group's span that no take covers (holes). */
  uncoveredBars: number[];
  /** Ordered take summaries (index = TAKE n in the lane UI order). */
  takeSummaries: Array<{
    takeId: string;
    score: TakeScore;
    coveredBarCount: number;
  }>;
  /** The group's absolute span in bars (union of all take clips). */
  spanStartBar: number;
  spanEndBar: number;
}

/** Linear/forward/one-pass rules — mirrors compAudioTakeRange's own gate. */
function isCompableClip(clip: AudioClip): boolean {
  return !clip.reverse && !clip.loop && clip.stretchMode !== "stretch" && (clip.warpMarkers?.length ?? 0) === 0;
}

/** Bar coverage of one take: the union of its compable clips' bar spans. */
function coveredBarRanges(
  clips: AudioClip[],
  groupId: string,
  takeId: string,
  trackId: string,
): Array<[number, number]> {
  return clips
    .filter((clip) => clip.takeGroupId === groupId && clip.takeId === takeId && clip.trackId === trackId)
    .filter(isCompableClip)
    .sort((a, b) => a.startBar - b.startBar)
    .map((clip) => [clip.startBar, clip.startBar + clip.lengthBars] as [number, number]);
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// Coverage queries read the MERGED ranges, so a take recorded as several
// punch-in clips still covers the bars between its clips when they abut.
function coveredRangesFor(
  clips: AudioClip[],
  groupId: string,
  takeId: string,
  trackId: string,
): Array<[number, number]> {
  return mergeRanges(coveredBarRanges(clips, groupId, takeId, trackId));
}

function coversBar(ranges: Array<[number, number]>, bar: number): boolean {
  return ranges.some(([start, end]) => bar >= start && bar < end);
}

/**
 * Build the plan. `pcmFor(takeId)` supplies the take's playable PCM — callers
 * resolve clip → buffer via the sample bank; a null (buffer not decoded yet)
 * means the take still competes on coverage but scores last. This keeps a
 * missing decode from producing a silent comp segment.
 */
export function planSmartComp(
  doc: ProjectDocument,
  groupId: string,
  pcmFor: (takeId: string) => { data: Float32Array; sampleRate: number } | null,
): SmartCompPlan {
  const group = doc.arrangement.takeGroups?.find((item) => item.id === groupId) as AudioTakeGroup | undefined;
  const empty: SmartCompPlan = {
    segments: [],
    uncoveredBars: [],
    takeSummaries: [],
    spanStartBar: 0,
    spanEndBar: 0,
  };
  if (!group) throw new Error(`Audio take group ${groupId} not found`);

  const clips = doc.arrangement.audioClips ?? [];
  // Source takes in lane order: clips sorted by startBar, ids first-seen.
  const takeIds: string[] = [];
  for (const clip of clips
    .filter((c) => c.takeGroupId === groupId && c.trackId === group.trackId)
    .sort((a, b) => a.startBar - b.startBar)) {
    if (clip.takeId && !takeIds.includes(clip.takeId)) takeIds.push(clip.takeId);
  }
  const sourceTakeIds = takeIds.filter((id) => id !== group.compTakeId);
  if (sourceTakeIds.length === 0) return { ...empty, takeSummaries: [] };

  // Union span of all source takes.
  let spanStart = Number.POSITIVE_INFINITY;
  let spanEnd = Number.NEGATIVE_INFINITY;
  for (const takeId of sourceTakeIds) {
    for (const [start, end] of coveredRangesFor(clips, groupId, takeId, group.trackId)) {
      spanStart = Math.min(spanStart, start);
      spanEnd = Math.max(spanEnd, end);
    }
  }
  if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd) || spanEnd <= spanStart) {
    return { ...empty, takeSummaries: [] };
  }

  // Score every take over its WHOLE pass (stable metrics, not bar noise).
  const takeSummaries: SmartCompPlan["takeSummaries"] = sourceTakeIds.map((takeId) => {
    const pcm = pcmFor(takeId);
    const score = pcm ? scoreTake(measureTake(pcm.data, pcm.sampleRate, doc.bpm)) : scoreMissingTake();
    return {
      takeId,
      score,
      coveredBarCount: coveredRangesFor(clips, groupId, takeId, group.trackId).reduce(
        (sum, [s, e]) => sum + (e - s),
        0,
      ),
    };
  });

  // Rank: score descending, coverage as tiebreak (more coverage = fewer seams
  // downstream even before merging).
  const ranked = [...takeSummaries].sort(
    (a, b) => b.score.score - a.score.score || b.coveredBarCount - a.coveredBarCount,
  );

  // Bar-by-bar winner, then merge adjacent equal winners.
  const winnerByBar = new Map<number, string>();
  const uncoveredBars: number[] = [];
  for (let bar = spanStart; bar < spanEnd; bar++) {
    const winner = ranked.find((entry) =>
      coversBar(coveredRangesFor(clips, groupId, entry.takeId, group.trackId), bar),
    );
    if (winner) winnerByBar.set(bar, winner.takeId);
    else uncoveredBars.push(bar);
  }

  const segments: CompSegment[] = [];
  let current: CompSegment | null = null;
  for (let bar = spanStart; bar < spanEnd; bar++) {
    const winner = winnerByBar.get(bar);
    if (winner === undefined) {
      current = null;
      continue;
    }
    if (current && current.sourceTakeId === winner && current.endBar === bar) {
      current.endBar = bar + 1;
    } else {
      current = { sourceTakeId: winner, startBar: bar, endBar: bar + 1 };
      segments.push(current);
    }
  }

  return {
    segments,
    uncoveredBars,
    takeSummaries,
    spanStartBar: spanStart,
    spanEndBar: spanEnd,
  };
}

/**
 * A take whose PCM has not been decoded (lazy bank, still streaming) is not
 * punished for a data-availability problem — but it must NOT win the comp on
 * metrics it never had. Honest bottom score, coverage still intact.
 */
function scoreMissingTake(): TakeScore {
  return {
    grooveTightness: Number.NaN,
    grooveMedianDeviationSec: Number.NaN,
    grooveSpreadSec: Number.NaN,
    noiseFloorDb: Number.NaN,
    clippedShare: 0,
    pitchDriftSemitones: Number.NaN,
    voicedFrames: 0,
    onsetCount: 0,
    score: 0,
    evidence: ["PCM not decoded yet — skipped from scoring, coverage intact"],
  };
}

/**
 * Tick bounds for one segment (the comp command speaks ticks, the plan speaks
 * bars; this is the single conversion point).
 */
export function segmentTicks(segment: CompSegment): { startTick: number; endTick: number } {
  return {
    startTick: segment.startBar * BAR_TICKS,
    endTick: segment.endBar * BAR_TICKS,
  };
}

/** Total planned bars — the UI shows this next to the segment count. */
export function planBars(plan: SmartCompPlan): number {
  return plan.segments.reduce((sum, segment) => sum + (segment.endBar - segment.startBar), 0);
}

/**
 * Apply a plan as ONE undoable command. Each segment becomes exactly one
 * `compAudioTakeRange` (verified, non-destructive, crossfaded); the plan
 * command composes them so a single Ctrl+Z removes the whole smart comp, not
 * one segment at a time. `execute` runs the segments in timeline order —
 * later seams never invalidate earlier ones, because compAudioTakeRange
 * rebuilds the range it is given from source material that never changes.
 *
 * The crossfade between different takes is the producer-audible seam, so the
 * plan passes the user's crossfade preference through rather than inventing
 * its own.
 */
export function applySmartComp(
  doc: ProjectDocument,
  groupId: string,
  plan: SmartCompPlan,
  crossfadeTicks = 0,
): Command {
  if (plan.segments.length === 0) {
    throw new Error("Nothing to comp — no segment won a bar in this group");
  }
  // Segment commands must be built against the RUNNING document, not the
  // initial one: `compAudioTakeRange` captures `compTakeId` from the group it
  // was handed, so building every command up-front against `doc` would mint a
  // SECOND comp take for segment 2 and scatter the comp across takes. Each
  // command is therefore constructed lazily over the accumulated state.
  const segmentCommands: Command[] = [];
  let running = doc;
  for (const segment of plan.segments) {
    const { startTick, endTick } = segmentTicks(segment);
    const command = compAudioTakeRange(running, groupId, segment.sourceTakeId, startTick, endTick, crossfadeTicks);
    segmentCommands.push(command);
    running = command.execute(running);
  }
  return {
    type: "applySmartComp",
    label: `Smart comp from ${plan.segments.length} segment${plan.segments.length === 1 ? "" : "s"}`,
    detail: `${planBars(plan)} bars · ${plan.segments.length} seam${plan.segments.length === 1 ? "" : "s"}${plan.uncoveredBars.length > 0 ? ` · ${plan.uncoveredBars.length} uncovered bar${plan.uncoveredBars.length === 1 ? "" : "s"} left untouched` : ""}`,
    execute: (d) => segmentCommands.reduce((acc, command) => command.execute(acc), d),
    undo: (d) => [...segmentCommands].reverse().reduce((acc, command) => command.undo(acc), d),
  };
}

/** Re-export for consumers that only import the planner. */
export { scoreTake, measureTake };
export type { TakeScore };
