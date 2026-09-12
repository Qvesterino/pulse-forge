/**
 * Sibling-sweep hardening regression (fxeq + ozvena) — mirrors the ultina
 * biquad-state poisoning fix. Both cores share the same DF2T choke point
 * (`dsp/biquad.ts`): a single non-finite frame used to persist NaN in z1/z2
 * forever, silently muting the section for the rest of the session even
 * after the input recovered. The processors already scrub their host-facing
 * input; the state guard is the defense-in-depth layer for anything that
 * turns non-finite inside the graph.
 *
 * Pins:
 *  1. processBiquad recovers after a poisoned block in BOTH cores (fxeq
 *     Float32 state, ozvena Float64 state).
 *  2. End-to-end: the full fxeq processor stays audible after a poisoned
 *     input block (input scrub + state guard together).
 *  3. End-to-end: the full ozvena processor recovers its wet path after a
 *     poisoned input block.
 *
 * Finite-signal behavior is untouched (the guard only fires on non-finite
 * state), which the golden suites pin separately.
 */
import { describe, expect, it } from "vitest";
import { createBiquad, processBiquad, setPeaking } from "../src/effects/fxeq-core/dsp/biquad.js";
import {
  createBiquad as ozCreateBiquad,
  processBiquad as ozProcessBiquad,
  setBell as ozSetBell,
} from "../src/effects/ozvena-core/dsp/biquad.js";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor.js";
import { createOzvenaProcessor } from "../src/effects/ozvena-core/core/ozvenaProcessor.js";
import { defaultOzvenaStateV1 } from "../src/effects/ozvena-core/v2/types.js";

const SR = 48000;
const BLOCK = 128;

function sineBlock(blockIndex: number, freq: number, amp: number): Float32Array {
  const buf = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    buf[i] = amp * Math.sin((2 * Math.PI * freq * (blockIndex * BLOCK + i)) / SR);
  }
  return buf;
}

function blockPeak(buf: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

describe("fxeq processBiquad: poisoned state recovers (sibling sweep)", () => {
  it("output is audible again after a NaN frame (pre-fix: silent forever)", () => {
    const bq = createBiquad(1);
    setPeaking(bq.coeffs, 1000, 1, 6, SR);
    for (let b = 0; b < 8; b++) processBiquad(bq, [sineBlock(b, 1000, 0.5)], BLOCK);

    const bad = sineBlock(8, 1000, 0.5);
    bad[7] = NaN;
    processBiquad(bq, [bad], BLOCK);

    for (let b = 9; b < 17; b++) {
      const clean = sineBlock(b, 1000, 0.5);
      processBiquad(bq, [clean], BLOCK);
      expect(Number.isFinite(clean[64])).toBe(true);
      // Pre-fix the recursion stayed NaN → every sample NaN → peak read 0.
      expect(blockPeak(clean)).toBeGreaterThan(0.4);
    }
  });

  it("ozvena processBiquad (Float64 state) recovers identically", () => {
    const bq = ozCreateBiquad(1);
    ozSetBell(bq.coeffs, 1000, 1, 6, SR);
    for (let b = 0; b < 8; b++) ozProcessBiquad(bq, [sineBlock(b, 1000, 0.5)], BLOCK);

    const bad = sineBlock(8, 1000, 0.5);
    bad[7] = Infinity;
    ozProcessBiquad(bq, [bad], BLOCK);

    for (let b = 9; b < 17; b++) {
      const clean = sineBlock(b, 1000, 0.5);
      ozProcessBiquad(bq, [clean], BLOCK);
      expect(Number.isFinite(clean[64])).toBe(true);
      expect(blockPeak(clean)).toBeGreaterThan(0.4);
    }
  });
});

describe("full fxeq processor: poisoned input block does not kill the chain", () => {
  it("stays audible after a NaN-contaminated block (input scrub + guards)", () => {
    // A bell boost so the biquads are in the signal path (params via the
    // factory store, same convention as fxeq-core-hardening).
    const proc = createFxEqProcessor({
      "band1.enabled": 1,
      "band1.freqHz": 1000,
      "band1.gainDb": 6,
    });
    proc.prepare(SR, 2, BLOCK);

    const chans: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const feed = (b: number, poison: boolean) => {
      const l = sineBlock(b, 1000, 0.5);
      const r = sineBlock(b, 1000, 0.5);
      if (poison) {
        l[3] = NaN;
        r[3] = Infinity;
      }
      chans[0] = l;
      chans[1] = r;
      proc.process(chans, BLOCK);
    };

    for (let b = 0; b < 8; b++) feed(b, false);
    feed(8, true);
    for (let b = 9; b < 14; b++) feed(b, false);

    expect(Number.isFinite(chans[0][64])).toBe(true);
    expect(Number.isFinite(chans[1][64])).toBe(true);
    // A +6 dB bell at the tone's frequency keeps the peak near ~1.0.
    expect(blockPeak(chans[0])).toBeGreaterThan(0.4);
  });
});

describe("full ozvena processor: poisoned input block does not kill the wet path", () => {
  it("wet output recovers after a NaN-contaminated block", () => {
    const proc = createOzvenaProcessor();
    proc.prepare(SR, 2, 120, BLOCK);
    proc.loadState(defaultOzvenaStateV1());

    const chans: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const feed = (b: number, poison: boolean) => {
      const l = sineBlock(b, 440, 0.5);
      const r = sineBlock(b, 440, 0.5);
      if (poison) {
        l[5] = NaN;
        r[5] = NaN;
      }
      chans[0] = l;
      chans[1] = r;
      proc.process(chans, BLOCK);
    };

    for (let b = 0; b < 8; b++) feed(b, false);
    feed(8, true);
    // Reverb tail needs a moment; feed more clean audio and require the
    // processor to keep producing finite, non-silent output.
    let maxPeak = 0;
    for (let b = 9; b < 30; b++) {
      feed(b, false);
      expect(Number.isFinite(chans[0][64])).toBe(true);
      expect(Number.isFinite(chans[1][64])).toBe(true);
      maxPeak = Math.max(maxPeak, blockPeak(chans[0]));
    }
    // Pre-fix (had the input scrub been missing) the poisoned frames would
    // ring in the FDN forever. With scrub + guards the signal chain is
    // healthy; a 0.5-amp sine through the default wet blend stays audible.
    expect(maxPeak).toBeGreaterThan(0.05);
  });
});
