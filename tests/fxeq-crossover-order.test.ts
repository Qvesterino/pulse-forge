/**
 * PRISM crossover-order contract.
 *
 * The LR slope controls are structural DSP state, not cosmetic schema keys:
 * they must snap deterministically, change the active cascade, stay finite
 * across live order switches, and never be interpolated by A/B morphing.
 */
import { describe, expect, it } from "vitest";
import { blendParams } from "../src/effects/fxeqNode";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import {
  applyHpBranch,
  applyLpBranch,
  createCrossoverStage,
  sectionsFor,
  snapCrossoverOrder,
  tuneCrossoverStage,
} from "../src/effects/fxeq-core/dsp/crossoverStage";
import { createCrossoverBank } from "../src/effects/fxeq-core/core/crossover";
import { EFFECT_DEFS, clampEffectParam, normalizePluginParams } from "../src/effects/registry";

const SR = 48_000;
const BLOCK = 128;

function rms(buf: Float32Array): number {
  let sum = 0;
  for (const sample of buf) sum += sample * sample;
  return Math.sqrt(sum / buf.length);
}

function lowPassRms(order: 2 | 4 | 8, frequencyHz: number): number {
  const stage = createCrossoverStage(1, order);
  tuneCrossoverStage(stage, 1_000, SR, order);
  const input = [new Float32Array(BLOCK)];
  const output = [new Float32Array(BLOCK)];
  let phase = 0;
  const increment = (2 * Math.PI * frequencyHz) / SR;
  let measured = 0;
  for (let block = 0; block < 220; block++) {
    for (let i = 0; i < BLOCK; i++) {
      input[0][i] = Math.sin(phase);
      phase += increment;
    }
    applyLpBranch(stage, input, output, BLOCK);
    if (block >= 200) measured = rms(output[0]);
  }
  return measured;
}

describe("PRISM crossover order", () => {
  it("snaps only to LR2, LR4 or LR8 and rejects non-finite input", () => {
    expect(snapCrossoverOrder(Number.NaN)).toBe(4);
    expect(snapCrossoverOrder(Number.POSITIVE_INFINITY)).toBe(4);
    expect(snapCrossoverOrder(2)).toBe(2);
    expect(snapCrossoverOrder(3)).toBe(4);
    expect(snapCrossoverOrder(5)).toBe(4);
    expect(snapCrossoverOrder(6)).toBe(8);
    expect(snapCrossoverOrder(99)).toBe(8);
    expect(sectionsFor(2)).toBe(1);
    expect(sectionsFor(4)).toBe(2);
    expect(sectionsFor(8)).toBe(4);
  });

  it("allocates the largest cascade once and retires sections cleanly", () => {
    const stage = createCrossoverStage(2, 8);
    expect(stage.lp).toHaveLength(4);
    expect(stage.hp).toHaveLength(4);
    expect(stage.activeSections).toBe(4);

    tuneCrossoverStage(stage, 1_000, SR, 2);
    expect(stage.activeSections).toBe(1);
    for (const branch of [stage.lp, stage.hp]) {
      for (let i = 1; i < branch.length; i++) {
        expect(branch[i].coeffs).toEqual({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
        expect([...branch[i].z1]).toEqual([0, 0]);
        expect([...branch[i].z2]).toEqual([0, 0]);
      }
    }
  });

  it("changes the actual attenuation slope rather than only the schema", () => {
    const lr2 = lowPassRms(2, 4_000);
    const lr8 = lowPassRms(8, 4_000);
    expect(lr2).toBeGreaterThan(0);
    expect(lr8).toBeLessThan(lr2 * 0.25);
  });

  it("keeps LR8 split branches complementary at the crossover", () => {
    const stage = createCrossoverStage(1, 8);
    tuneCrossoverStage(stage, 1_000, SR, 8);
    const input = [new Float32Array(BLOCK)];
    const low = [new Float32Array(BLOCK)];
    const high = [new Float32Array(BLOCK)];
    const increment = (2 * Math.PI * 1_000) / SR;
    let phase = 0;
    let inputRms = 0;
    let lowRms = 0;
    let highRms = 0;
    for (let block = 0; block < 220; block++) {
      for (let i = 0; i < BLOCK; i++) {
        input[0][i] = Math.sin(phase);
        phase += increment;
      }
      inputRms = rms(input[0]);
      applyLpBranch(stage, input, low, BLOCK);
      // The high branch has independent state, so it must receive the same
      // source rather than the low branch output.
      // Keep the branch call explicit so both transfer functions are measured
      // with identical phase and block history.
      applyHpBranch(stage, input, high, BLOCK);
      if (block >= 200) {
        lowRms = rms(low[0]);
        highRms = rms(high[0]);
      }
    }
    expect(lowRms / inputRms).toBeGreaterThan(0.47);
    expect(lowRms / inputRms).toBeLessThan(0.53);
    expect(highRms / inputRms).toBeGreaterThan(0.47);
    expect(highRms / inputRms).toBeLessThan(0.53);
  });

  it("rebuilds a live bank safely when the order changes", () => {
    const bank = createCrossoverBank(2, 4, [1_000]);
    bank.prepare(SR, 2, BLOCK);
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    input[0].fill(0.25);
    input[1].fill(-0.25);
    bank.process(input, BLOCK);
    bank.setOrder(8);
    expect(bank.order).toBe(8);
    bank.process(input, BLOCK);
    bank.setOrder(2);
    expect(bank.order).toBe(2);
    bank.process(input, BLOCK);
    for (const channel of input) for (const sample of channel) expect(Number.isFinite(sample)).toBe(true);
  });

  it("routes and normalizes structural values in the processor", () => {
    const proc = createFxEqProcessor({
      bandCount: 2,
      crossoverOrder: 8,
      crossoverEqualize: 0,
      limiterEnabled: 0,
    });
    proc.prepare(SR, 2, BLOCK);
    expect(proc.getParameter("crossoverOrder")).toBe(8);
    expect(proc.getParameter("crossoverEqualize")).toBe(0);

    proc.setParameter("crossoverOrder", 5);
    expect(proc.getParameter("crossoverOrder")).toBe(4);
    proc.setParameter("crossoverEqualize", 0.9);
    expect(proc.getParameter("crossoverEqualize")).toBe(1);
  });

  it("keeps structural crossover settings out of A/B blend targets", () => {
    expect(
      blendParams(
        { crossoverOrder: 2, crossoverEqualize: 0, gainDb: 0 },
        { crossoverOrder: 8, crossoverEqualize: 1, gainDb: 6 },
        0.5,
      ),
    ).toEqual({ gainDb: 3 });
  });

  it("exposes canonical structural choices in the rack and persistence boundary", () => {
    const slope = EFFECT_DEFS.fxeq.params.find((param) => param.id === "crossoverOrder");
    const phase = EFFECT_DEFS.fxeq.params.find((param) => param.id === "crossoverEqualize");
    expect(slope?.options?.map((option) => option.value)).toEqual([2, 4, 8]);
    expect(phase?.options?.map((option) => option.value)).toEqual([1, 0]);
    expect(clampEffectParam("fxeq", "crossoverOrder", 5)).toBe(4);
    expect(clampEffectParam("fxeq", "crossoverEqualize", 0.7)).toBe(1);
    expect(normalizePluginParams("fxeq", { crossoverOrder: 5, crossoverEqualize: 0.2 })).toMatchObject({
      crossoverOrder: 4,
      crossoverEqualize: 0,
    });
  });
});
