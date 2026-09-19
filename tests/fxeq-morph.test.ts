/**
 * FXEQ A/B morph — correctness after the precompiled-morph optimization.
 *
 * The morph used to re-run applyAllParams() every audio block (full schema
 * walk + unconditional crossover stage rebuild). It now precompiles routed
 * entries at startMorph() and routes only those per block, pinning the
 * exact end state with one final applyAllParams() when the morph completes.
 *
 * These tests pin the behavior that optimization must preserve:
 *   - interpolation reaches the target and terminates,
 *   - the end state is FULLY routed (a reset() + excitation comparison
 *     against a freshly-loaded reference processor must match — this fails
 *     if the last block's values never reached the sub-components),
 *   - parameters outside the morph target survive untouched,
 *   - bandCount inside a morph target rebuilds the schema correctly,
 *   - non-finite morph targets are dropped instead of poisoning DSP state.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";

const SR = 48000;
const BLOCK = 128;

function noiseChannels(seed = 0x9e3779b9): Float32Array[] {
  let s = seed;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0x100000000) * 2 - 1;
  };
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    l[i] = rnd() * 0.7;
    r[i] = rnd() * 0.7;
  }
  return [l, r];
}

function runBlocks(proc: ReturnType<typeof createFxEqProcessor>, channels: Float32Array[], blocks: number): void {
  for (let i = 0; i < blocks; i++) proc.process(channels, BLOCK);
}

function runUntilMorphDone(
  proc: ReturnType<typeof createFxEqProcessor>,
  channels: Float32Array[],
  maxBlocks = 100000,
): number {
  let blocks = 0;
  while (proc.isMorphing && blocks < maxBlocks) {
    proc.process(channels, BLOCK);
    blocks++;
  }
  expect(proc.isMorphing, "morph did not finish within the block budget").toBe(false);
  return blocks;
}

const MORPH_TARGET = {
  "band1.gainDb": 6,
  "band2.gainDb": -4.5,
  "band2.satEnabled": 1,
  "band2.satDriveDb": 18,
  "band2.satMode": 2,
  "band3.modEnabled": 1,
  "band3.modRate": 2.5,
  "band3.modDepth": 70,
  crossoverFreq2: 700,
  globalMix: 60,
};

describe("fxeq A/B morph (precompiled routing)", () => {
  it("interpolates toward the target and terminates", () => {
    const proc = createFxEqProcessor({ limiterEnabled: 0 });
    proc.prepare(SR, 2, BLOCK);
    const startVal = proc.getParameter("band1.gainDb");
    proc.startMorph(MORPH_TARGET, 0.05); // ~19 blocks at 48 kHz / 128
    const channels = noiseChannels();
    runBlocks(proc, channels, 8);
    const mid = proc.getParameter("band1.gainDb");
    expect(mid).toBeGreaterThan(startVal);
    expect(mid).toBeLessThan(MORPH_TARGET["band1.gainDb"]);
    runUntilMorphDone(proc, channels);
    expect(proc.getParameter("band1.gainDb")).toBeCloseTo(MORPH_TARGET["band1.gainDb"], 6);
    expect(proc.getParameter("band2.satDriveDb")).toBeCloseTo(18, 6);
    expect(proc.getParameter("globalMix")).toBeCloseTo(60, 6);
  });

  it("leaves a fully-routed end state — reset(excitation) matches a fresh reference", () => {
    const channels = noiseChannels();
    // Explicit neighbour for the crossoverFreq2: 700 target — without it the
    // single-change clamp would pull the morph toward the freq3 default.
    const baseParams = { limiterEnabled: 0, crossoverFreq3: 1200 };
    const morphed = createFxEqProcessor(baseParams);
    morphed.prepare(SR, 2, BLOCK);
    morphed.startMorph(MORPH_TARGET, 0.03);
    runUntilMorphDone(morphed, channels);
    runBlocks(morphed, channels, 4);
    morphed.reset();

    const reference = createFxEqProcessor(baseParams);
    reference.prepare(SR, 2, BLOCK);
    reference.loadParameters(MORPH_TARGET);
    reference.reset();

    // If the final applyAllParams() were missing (or the last blocks' values
    // never reached the sub-components), these outputs would diverge.
    for (let blk = 0; blk < 12; blk++) {
      const a = noiseChannels(0xabcd + blk);
      const b = noiseChannels(0xabcd + blk);
      morphed.process(a, BLOCK);
      reference.process(b, BLOCK);
      let maxDiff = 0;
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < BLOCK; i++) {
          maxDiff = Math.max(maxDiff, Math.abs(a[c][i] - b[c][i]));
        }
      }
      expect(maxDiff, `block ${blk} diverged from the reference end state`).toBeLessThan(1e-5);
    }
  });

  it("parameters outside the morph target survive the morph untouched", () => {
    const proc = createFxEqProcessor({ limiterEnabled: 0 });
    proc.prepare(SR, 2, BLOCK);
    proc.setParameter("outputGainDb", -6);
    proc.setParameter("band4.gainDb", 3);
    proc.startMorph(MORPH_TARGET, 0.02);
    const channels = noiseChannels();
    runBlocks(proc, channels, 5); // mid-morph
    proc.setParameter("outputGainDb", -9); // user grabs a knob during the morph
    runUntilMorphDone(proc, channels);
    expect(proc.getParameter("outputGainDb")).toBe(-9);
    expect(proc.getParameter("band4.gainDb")).toBe(3);
  });

  it("bandCount inside a morph target is dropped, other entries still land", () => {
    // 2026-09-12 contract change: bandCount must never MORPH — routing it
    // rebuilt the schema and crossover on the audio thread every block for
    // the morph's duration (and fractional counts round mid-glide). The
    // core now skips it; hosts exclude it in their blend step too. The
    // rest of the target still applies against the CURRENT schema.
    const proc = createFxEqProcessor({ limiterEnabled: 0 });
    proc.prepare(SR, 2, BLOCK);
    proc.startMorph({ bandCount: 5, "band3.gainDb": 3 }, 0.02);
    const channels = noiseChannels();
    runUntilMorphDone(proc, channels);
    expect(proc.getParameter("bandCount")).toBe(6);
    expect(proc.getParameter("band3.gainDb")).toBeCloseTo(3, 6);
    // The parameter space still accepts parameters after the morph.
    proc.setParameter("band3.mute", 1);
    expect(proc.getParameter("band3.mute")).toBe(1);
  });

  it("drops non-finite morph targets instead of poisoning DSP state", () => {
    const proc = createFxEqProcessor({ limiterEnabled: 0 });
    proc.prepare(SR, 2, BLOCK);
    proc.startMorph(
      {
        "band1.gainDb": Number.NaN,
        "band2.gainDb": Number.POSITIVE_INFINITY,
        "band3.gainDb": 4,
      },
      0.01,
    );
    const channels = noiseChannels();
    runUntilMorphDone(proc, channels);
    expect(proc.getParameter("band1.gainDb")).toBe(0);
    expect(proc.getParameter("band2.gainDb")).toBe(0);
    expect(proc.getParameter("band3.gainDb")).toBeCloseTo(4, 6);
    runBlocks(proc, channels, 8);
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(channels[0][i])).toBe(true);
      expect(Number.isFinite(channels[1][i])).toBe(true);
    }
  });

  it("restarting a morph mid-flight starts from the current values", () => {
    const proc = createFxEqProcessor({ limiterEnabled: 0 });
    proc.prepare(SR, 2, BLOCK);
    const channels = noiseChannels();
    proc.startMorph({ "band1.gainDb": 12 }, 1.0);
    runBlocks(proc, channels, 10); // partial
    const partial = proc.getParameter("band1.gainDb");
    expect(partial).toBeGreaterThan(0);
    proc.startMorph({ "band1.gainDb": -12 }, 0.02); // interrupt + reverse
    runUntilMorphDone(proc, channels);
    expect(proc.getParameter("band1.gainDb")).toBeCloseTo(-12, 6);
  });
});
