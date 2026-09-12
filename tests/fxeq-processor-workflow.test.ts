/**
 * FXEQ processor contract tests for the host-facing workflow surface.
 *
 * These tests deliberately exercise the real portable processor rather than
 * a UI mock: bulk state loads must not leave a morph writing into the next
 * block, preset/sync loads must reset local parameter history, and the
 * limiter meter must expose a finite positive reduction under hot input.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

const SR = 48_000;
const BLOCK = 128;

function stereoTone(amplitude: number, phase = 0): Float32Array[] {
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const value = Math.sin((2 * Math.PI * 997 * (phase * BLOCK + i)) / SR) * amplitude;
    left[i] = value;
    right[i] = value;
  }
  return [left, right];
}

describe("FXEQ processor workflow contract", () => {
  it("bulk state load cancels an active morph and clears stale undo history", () => {
    const proc = createFxEqProcessor({ limiterEnabled: 0 });
    proc.prepare(SR, 2, BLOCK);

    proc.setParameter("band1.gainDb", 6);
    expect(proc.canUndo).toBe(true);

    proc.startMorph({ "band1.gainDb": 12 }, 1);
    proc.process(stereoTone(0.25), BLOCK);
    expect(proc.isMorphing).toBe(true);

    proc.loadParameters({ "band1.gainDb": -6 });
    expect(proc.isMorphing).toBe(false);
    expect(proc.canUndo).toBe(false);
    expect(proc.canRedo).toBe(false);
    expect(proc.getParameter("band1.gainDb")).toBe(-6);

    // A later render quantum must not let the cancelled morph overwrite the
    // newly loaded state.
    proc.process(stereoTone(0.25, 1), BLOCK);
    expect(proc.getParameter("band1.gainDb")).toBe(-6);
  });

  it("history recording can be paused without recording programmatic changes", () => {
    const proc = createFxEqProcessor({ limiterEnabled: 0 });
    proc.prepare(SR, 2, BLOCK);

    proc.setHistoryRecording(false);
    proc.setParameter("band1.gainDb", 3);
    expect(proc.canUndo).toBe(false);

    proc.setHistoryRecording(true);
    proc.setParameter("band1.gainDb", 6);
    expect(proc.canUndo).toBe(true);
    expect(proc.undo()).toEqual({ id: "band1.gainDb", value: 3 });
    expect(proc.getParameter("band1.gainDb")).toBe(3);
  });

  it("reports finite positive limiter gain reduction for hot input", () => {
    const proc = createFxEqProcessor({
      limiterEnabled: 1,
      limiterCeilDb: -6,
      limiterTruePeak: 0,
      limiterLookaheadMs: 0,
      globalMix: 100,
    });
    proc.prepare(SR, 2, BLOCK);

    for (let block = 0; block < 40; block++) {
      proc.process(stereoTone(0.95, block), BLOCK);
    }

    const reduction = proc.getGainReductionDb();
    expect(Number.isFinite(reduction)).toBe(true);
    expect(reduction).toBeGreaterThan(0);
  });
});
