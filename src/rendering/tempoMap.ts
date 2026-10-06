import { PPQ } from "../project-model/types";
import type { ProjectDocument } from "../project-model/types";

/**
 * Piecewise tick→seconds tempo map — extracted from renderer.ts so the
 * bounce/consolidation doc builders (boot graph) can use it WITHOUT the
 * offline renderer (which drags the engine + worklet loaders and must stay
 * behind first use). Pure math: every window runs at its scene's BPM, gaps
 * between windows run at the project BPM. The renderer re-exports this
 * module, so every existing import site keeps working.
 */

/** Minimal tempo window — the renderer's full ClipWindow satisfies it. */
export interface TempoWindow {
  from: number;
  to: number;
  /** Scene tempo for this window (falls back to the project BPM). */
  bpm?: number;
}

export interface TempoSegment {
  from: number;
  to: number;
  bpm: number;
  /** Wall-clock time (seconds) at `from`. */
  startTime: number;
}

/**
 * Piecewise tick→seconds map for scene tempo lanes: every window runs at its
 * scene's BPM, gaps between windows run at the project BPM. Pure — the
 * offline render and its length computation both consume it.
 */
export function buildTempoMap(
  doc: ProjectDocument,
  windows: readonly TempoWindow[],
): {
  segments: TempoSegment[];
  totalSeconds: number;
  timeAt: (tick: number) => number;
  tickAt: (seconds: number) => number;
} {
  const docSpt = 60 / (doc.bpm * PPQ);
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  const segments: TempoSegment[] = [];
  let cursorTick = 0;
  let cursorTime = 0;
  for (const w of sorted) {
    if (w.from > cursorTick) {
      // Gap: project-tempo travel up to the window start.
      cursorTime += (w.from - cursorTick) * docSpt;
      cursorTick = w.from;
    }
    const bpm = w.bpm ?? doc.bpm;
    const spt = 60 / (bpm * PPQ);
    segments.push({ from: w.from, to: w.to, bpm, startTime: cursorTime });
    cursorTime += (w.to - w.from) * spt;
    cursorTick = Math.max(cursorTick, w.to);
  }
  const totalSeconds = cursorTime;
  const timeAt = (tick: number): number => {
    if (segments.length === 0) return tick * docSpt;
    const segmentEndTime = (segment: TempoSegment): number =>
      segment.startTime + (segment.to - segment.from) * (60 / (segment.bpm * PPQ));
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (tick >= segment.from && tick <= segment.to) {
        return segment.startTime + (tick - segment.from) * (60 / (segment.bpm * PPQ));
      }
      if (tick < segment.from) {
        // A gap before the first window, or between two windows, runs at the
        // project tempo. Anchor it to the nearest preceding edge instead of
        // extrapolating from the last scene (which can collapse an AudioClip
        // beyond that scene to a zero-second render duration).
        const previous = segments[index - 1];
        return previous ? segmentEndTime(previous) + (tick - previous.to) * docSpt : tick * docSpt;
      }
    }
    // Beyond the final scene window, continue from its actual end time and
    // then advance at the project tempo.
    const last = segments[segments.length - 1];
    return segmentEndTime(last) + (tick - last.to) * docSpt;
  };
  const tickAt = (seconds: number): number => {
    if (!Number.isFinite(seconds)) return 0;
    if (segments.length === 0) return seconds / docSpt;
    const segmentEndTime = (segment: TempoSegment): number =>
      segment.startTime + (segment.to - segment.from) * (60 / (segment.bpm * PPQ));
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (seconds < segment.startTime) {
        const previous = segments[index - 1];
        return previous ? previous.to + (seconds - segmentEndTime(previous)) / docSpt : seconds / docSpt;
      }
      const endTime = segmentEndTime(segment);
      if (seconds <= endTime) {
        return segment.from + (seconds - segment.startTime) / (60 / (segment.bpm * PPQ));
      }
    }
    const last = segments[segments.length - 1];
    return last.to + (seconds - segmentEndTime(last)) / docSpt;
  };
  return { segments, totalSeconds, timeAt, tickAt };
}
