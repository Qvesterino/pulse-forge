/**
 * FXEQ plugin-surface additions (host wiring enablement):
 *   - setHistoryRecording: programmatic replays must not pollute undo
 *   - loadParameters: bulk state replacement cancels a running morph and
 *     clears recorded history
 *   - getGainReductionDb: the output limiter's reduction, for metering
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

const SR = 48000;
const BLOCK = 128;

function noiseBlock(seedRef: { seed: number }): Float32Array[] {
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    seedRef.seed ^= seedRef.seed << 13;
    seedRef.seed ^= seedRef.seed >>> 17;
    seedRef.seed ^= seedRef.seed << 5;
    l[i] = ((seedRef.seed >>> 0) / 0x100000000) * 1.8 - 0.9;
    seedRef.seed ^= seedRef.seed << 13;
    seedRef.seed ^= seedRef.seed >>> 17;
    seedRef.seed ^= seedRef.seed << 5;
    r[i] = ((seedRef.seed >>> 0) / 0x100000000) * 1.8 - 0.9;
  }
  return [l, r];
}

describe("fxeq core history recording gate", () => {
  it("setParameter records by default; recording-off swallows the gesture; re-enable restores it", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);

    proc.setParameter("inputGainDb", -6);
    expect(proc.undo()).toEqual({ id: "inputGainDb", value: 0 });

    proc.setHistoryRecording(false);
    proc.setParameter("inputGainDb", 3);
    expect(proc.undo()).toBeNull();
    // canUndo/canRedo read false while gated even if entries existed before.
    proc.setParameter("inputGainDb", 2);
    expect(proc.canUndo).toBe(false);

    proc.setHistoryRecording(true);
    proc.setParameter("inputGainDb", 1);
    expect(proc.canUndo).toBe(true);
    expect(proc.undo()).toEqual({ id: "inputGainDb", value: 2 });
  });

  it("redo re-applies the CHANGE (regression: redo repeated the undo value)", () => {
    // The command entry used to store only the pre-change value, so redo
    // restored the OLD value again — a silent second undo. With the wiring
    // live this becomes user-visible, hence the regression test.
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.setParameter("inputGainDb", -6);
    expect(proc.undo()?.value).toBe(0);
    expect(proc.getParameter("inputGainDb")).toBe(0);
    const redone = proc.redo();
    expect(redone).toEqual({ id: "inputGainDb", value: -6 });
    expect(proc.getParameter("inputGainDb")).toBe(-6);
    // A full cycle keeps working (undo after redo).
    expect(proc.undo()?.value).toBe(0);
  });

  it("drag coalescing keeps redo on the freshest gesture position", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.setParameter("inputGainDb", -6);
    proc.setParameter("inputGainDb", -12); // coalesces into the same gesture
    expect(proc.undo()?.value).toBe(0);
    expect(proc.redo()?.value).toBe(-12);
  });
});

describe("fxeq core loadParameters side effects", () => {
  it("cancels a running morph — the loaded state must win", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.startMorph({ inputGainDb: 12 }, 60); // far in the future
    expect(proc.isMorphing).toBe(true);
    proc.loadParameters({ inputGainDb: -12 });
    expect(proc.isMorphing).toBe(false);
    // And the loaded value stays (the morph must not overwrite it per block).
    const seedRef = { seed: 0x123 };
    for (let i = 0; i < 20; i++) proc.process(noiseBlock(seedRef), BLOCK);
    expect(proc.getParameter("inputGainDb")).toBe(-12);
  });

  it("clears recorded history across a bulk state replacement", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.setParameter("inputGainDb", -6);
    expect(proc.canUndo).toBe(true);
    proc.loadParameters({ inputGainDb: 3 });
    expect(proc.canUndo).toBe(false);
    expect(proc.undo()).toBeNull();
  });
});

describe("fxeq core gain-reduction metering", () => {
  it("reports 0 with the limiter disabled", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ limiterEnabled: 0 });
    const seedRef = { seed: 0x777 };
    for (let i = 0; i < 30; i++) proc.process(noiseBlock(seedRef), BLOCK);
    expect(proc.getGainReductionDb()).toBe(0);
  });

  it("reports positive reduction for a hot signal into a low ceiling", () => {
    const proc = createFxEqProcessor();
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ limiterEnabled: 1, limiterCeilDb: -6, limiterLookaheadMs: 2 });
    const seedRef = { seed: 0x999 };
    let gr = 0;
    for (let i = 0; i < 60; i++) {
      proc.process(noiseBlock(seedRef), BLOCK);
      gr = proc.getGainReductionDb();
    }
    expect(gr).toBeGreaterThan(1);
  });
});
