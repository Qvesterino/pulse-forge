import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { DrumTrack } from "../src/project-model/types";
import { STEP_TICKS } from "../src/project-model/types";

// Mirrors AudioEngine.trigger length handling for test
function effectiveSliceDuration(
  bufferDuration: number,
  _sliceDuration: number,
  lengthMul: number | undefined,
  reverse: boolean,
  sliceStart: number,
  sliceEnd: number,
): number {
  let slice = {
    start: sliceStart,
    end: sliceEnd,
    duration: sliceEnd - sliceStart,
    reverse,
    offset: reverse ? sliceEnd : sliceStart,
  } as any;
  if (lengthMul !== undefined) {
    const mul = Math.min(2, Math.max(0.1, lengthMul));
    const baseDur = slice.duration;
    const newDurRaw = baseDur * mul;
    if (!slice.reverse) {
      const maxDur = Math.max(0.02, bufferDuration - slice.start);
      const newDur = Math.max(0.02, Math.min(maxDur, newDurRaw));
      slice = { ...slice, duration: newDur, end: slice.start + newDur, offset: slice.start };
    } else {
      const maxDur = Math.max(0.02, slice.end);
      const newDur = Math.max(0.02, Math.min(maxDur, newDurRaw));
      const newStart = Math.max(0, slice.end - newDur);
      slice = { ...slice, start: newStart, duration: newDur, offset: slice.end };
    }
  }
  return slice.duration;
}

describe("p-lock length in export (live == offline)", () => {
  it("length 0.5 truncates the sample vs full length (pure slice math)", async () => {
    const bufferDuration = 1.0;
    const sliceDuration = 1.0;
    const full = effectiveSliceDuration(bufferDuration, sliceDuration, undefined, false, 0, 1);
    const half = effectiveSliceDuration(bufferDuration, sliceDuration, 0.5, false, 0, 1);
    const double = effectiveSliceDuration(bufferDuration, sliceDuration, 2, false, 0, 1);
    expect(full).toBeCloseTo(1.0, 5);
    expect(half).toBeCloseTo(0.5, 5);
    // Double clamped to buffer duration (1.0)
    expect(double).toBeCloseTo(1.0, 5);

    // With a sliced pad 0.2..0.6 (0.4 dur), length 0.5 => 0.2
    const sliced = effectiveSliceDuration(bufferDuration, 0.4, 0.5, false, 0.2, 0.6);
    expect(sliced).toBeCloseTo(0.2, 5);
    const sliced2 = effectiveSliceDuration(bufferDuration, 0.4, 2, false, 0.2, 0.6);
    expect(sliced2).toBeCloseTo(0.8, 5);

    // Reverse case
    const revHalf = effectiveSliceDuration(bufferDuration, 1.0, 0.5, true, 0, 1);
    expect(revHalf).toBeCloseTo(0.5, 5);
  });

  it("length lock is sanitized and carried through groove", async () => {
    const { drumHitsInWindow } = await import("../src/project-model/groove");
    const baseDoc = createProjectFromTemplate("empty");
    const drum = baseDoc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const padId = drum.pads[0].id;
    const pattern = baseDoc.patterns[0];
    pattern.rows[padId] = new Array<number>(pattern.stepCount).fill(0);
    pattern.rows[padId][0] = 0.9;
    pattern.stepMeta = { [padId]: { 0: { locks: { length: 0.5, cutoff: 800, sampleStart: 0.25 } } } };
    const hits = drumHitsInWindow(baseDoc, pattern, 0, 0, STEP_TICKS * pattern.stepCount);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].locks?.length).toBeCloseTo(0.5);
    expect(hits[0].locks?.cutoff).toBe(800);
    expect(hits[0].locks?.sampleStart).toBeCloseTo(0.25);
  });
});
