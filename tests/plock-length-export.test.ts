import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { DrumTrack } from "../src/project-model/types";
import { STEP_TICKS } from "../src/project-model/types";

// Mirrors AudioEngine.trigger slice handling for test
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

function effectiveSliceStart(
  bufferDuration: number,
  sliceStart: number,
  sliceEnd: number,
  sampleStartFrac: number | undefined,
): { start: number; end: number; duration: number } {
  let start = sliceStart;
  let end = sliceEnd;
  let duration = end - start;
  if (sampleStartFrac !== undefined) {
    const frac = Math.min(1, Math.max(0, sampleStartFrac));
    const maxStart = Math.max(0, bufferDuration - duration - 0.001);
    const newStart = frac * maxStart;
    const newEnd = Math.min(bufferDuration, newStart + duration);
    const newDur = Math.max(0.001, newEnd - newStart);
    start = newStart;
    end = newEnd;
    duration = newDur;
  }
  return { start, end, duration };
}

describe("p-lock length/cutoff/sampleStart in export (live == offline)", () => {
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

  it("sampleStart 0.5 shifts slice start within buffer", () => {
    const bufferDuration = 2.0;
    // Full slice 0..1 (1 sec) with maxStart = 0.999, frac 0.5 => start ~0.4995, end ~1.4995
    const shifted = effectiveSliceStart(bufferDuration, 0, 1, 0.5);
    expect(shifted.start).toBeCloseTo(0.4995, 2);
    expect(shifted.end).toBeCloseTo(1.4995, 2);
    // Sliced 0.2..0.6 (0.4) with maxStart = 1.599, frac 1.0 => start 1.599
    const edge = effectiveSliceStart(bufferDuration, 0.2, 0.6, 1.0);
    expect(edge.start).toBeCloseTo(1.599, 3);
    // No lock keeps original
    const noLock = effectiveSliceStart(bufferDuration, 0.2, 0.6, undefined);
    expect(noLock.start).toBeCloseTo(0.2, 5);
  });

  it("sampleStart and length combine (start then length)", () => {
    const bufferDuration = 2.0;
    // Start 0.5 (0.799), length 0.5 on 0.4 slice => start 0.799, duration 0.2
    const afterStart = effectiveSliceStart(bufferDuration, 0.2, 0.6, 0.5);
    const afterLength = effectiveSliceDuration(
      bufferDuration,
      afterStart.duration,
      0.5,
      false,
      afterStart.start,
      afterStart.end,
    );
    expect(afterLength).toBeCloseTo(0.2, 5);
  });

  it("all locks are sanitized and carried through groove (live == offline)", async () => {
    const { drumHitsInWindow } = await import("../src/project-model/groove");
    const baseDoc = createProjectFromTemplate("empty");
    const drum = baseDoc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const padId = drum.pads[0].id;
    const pattern = baseDoc.patterns[0];
    pattern.rows[padId] = new Array<number>(pattern.stepCount).fill(0);
    pattern.rows[padId][0] = 0.9;
    pattern.stepMeta = {
      [padId]: { 0: { locks: { length: 0.5, cutoff: 800, sampleStart: 0.25, pitch: 7, gain: 1.5, pan: -0.3 } } },
    };
    const hits = drumHitsInWindow(baseDoc, pattern, 0, 0, STEP_TICKS * pattern.stepCount);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].locks?.length).toBeCloseTo(0.5);
    expect(hits[0].locks?.cutoff).toBe(800);
    expect(hits[0].locks?.sampleStart).toBeCloseTo(0.25);
    expect(hits[0].locks?.pitch).toBeCloseTo(7);
    expect(hits[0].locks?.gain).toBeCloseTo(1.5);
    expect(hits[0].locks?.pan).toBeCloseTo(-0.3);
  });

  it("cutoff/sampleStart/length sanitize via normalizeProject", async () => {
    const { normalizeProject } = await import("../src/project-model/schema");
    const base = createProjectFromTemplate("empty");
    const drum = base.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
    const padId = drum.pads[0].id;
    const dirty: any = {
      ...base,
      patterns: base.patterns.map((p) => ({
        ...p,
        stepMeta: {
          [padId]: {
            0: { locks: { cutoff: 99999, sampleStart: -1, length: 10, pitch: 100 } },
            1: { locks: { cutoff: 5000, sampleStart: 0.5, length: 1 } },
          },
        },
      })),
    };
    const norm = normalizeProject(dirty);
    const locks0 = norm.patterns[0].stepMeta?.[padId]?.[0]?.locks;
    const locks1 = norm.patterns[0].stepMeta?.[padId]?.[1]?.locks;
    // Clamped
    expect(locks0?.cutoff).toBe(16000);
    expect(locks0?.sampleStart).toBe(0);
    expect(locks0?.length).toBe(2);
    expect(locks0?.pitch).toBe(24);
    expect(locks1?.cutoff).toBe(5000);
    expect(locks1?.sampleStart).toBeCloseTo(0.5);
    expect(locks1?.length).toBe(1);
  });
});
