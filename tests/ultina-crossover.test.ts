/**
 * Ultina crossover band-count switching — regression coverage.
 *
 * CrossoverNetwork pre-allocates filters for the MAXIMUM band count (3) and
 * setBandCount() resets filter STATE but never coefficients. The split paths
 * must therefore only run the splits the ACTIVE band count needs: a module
 * configured 3-band and switched to 2-band (comp/gate/density/exciter/
 * transient all do this via updateMultiband) leaves split 1's stale HP
 * coefficients behind. Running that split anyway double-filters the high
 * band and breaks the LR4 allpass (flat) sum.
 *
 * Invariants asserted here:
 *  1. LR4 bands sum to an allpass — a steady sine keeps its amplitude
 *     through split+sum at ANY band count, before and after switching.
 *  2. A network switched 3-band → 2-band behaves identically to one that
 *     was configured 2-band from scratch (no stale-coefficient leakage).
 */
import { describe, expect, it } from "vitest";
import { CrossoverNetwork } from "../src/effects/ultina-core/dsp/multiband.js";

const SR = 48000;
const BLOCK = 128;

interface Harness {
  xover: CrossoverNetwork;
  bandOut: Float32Array[][];
  sum: Float32Array[];
}

function makeNetwork(bandCount: 1 | 2 | 3): Harness {
  const xover = new CrossoverNetwork();
  xover.prepare(2, bandCount, BLOCK);
  const bandOut: Float32Array[][] = [];
  for (let b = 0; b < 3; b++) {
    bandOut.push([new Float32Array(BLOCK), new Float32Array(BLOCK)]);
  }
  const sum = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  return { xover, bandOut, sum };
}

/** Run `seconds` of a sine through split+sum; return the peak of the LAST 25 ms. */
function runSine(h: Harness, freqHz: number, seconds: number, amplitude = 0.5): number {
  const totalBlocks = Math.round((seconds * SR) / BLOCK);
  let peak = 0;
  const tailBlocks = Math.round((0.025 * SR) / BLOCK);
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let blk = 0; blk < totalBlocks; blk++) {
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < BLOCK; i++) {
        const t = (blk * BLOCK + i) / SR;
        input[ch][i] = amplitude * Math.sin(2 * Math.PI * freqHz * t);
      }
    }
    h.xover.split(input, h.bandOut, BLOCK, SR);
    h.xover.sum(h.bandOut, h.sum, BLOCK);
    if (blk >= totalBlocks - tailBlocks) {
      for (let i = 0; i < BLOCK; i++) {
        const a = Math.abs(h.sum[0][i]);
        if (a > peak) peak = a;
      }
    }
  }
  return peak;
}

describe("CrossoverNetwork band-count switching", () => {
  it("3-band LR4 sum is flat (allpass) for tones in every band region", () => {
    for (const freq of [100, 1000, 8000]) {
      const h = makeNetwork(3);
      h.xover.setFrequency(0, 250, SR);
      h.xover.setFrequency(1, 2500, SR);
      const peak = runSine(h, freq, 1.0);
      expect(peak).toBeCloseTo(0.5, 1);
    }
  });

  it("2-band LR4 sum is flat (allpass)", () => {
    const h = makeNetwork(2);
    h.xover.setFrequency(0, 250, SR);
    // A tone near a typical second crossover must survive the switch below.
    const peak = runSine(h, 3000, 1.0);
    expect(peak).toBeCloseTo(0.5, 1);
  });

  it("switching 3-band → 2-band keeps the LR4 sum allpass (no stale split-1 filtering)", () => {
    const h = makeNetwork(3);
    h.xover.setFrequency(0, 250, SR);
    h.xover.setFrequency(1, 2500, SR);
    runSine(h, 3000, 0.5); // settle 3-band state

    // The exact path comp/gate/density/exciter/transient take on bandCount change.
    h.xover.setBandCount(2);

    // 3 kHz sits 1.2× above the stale 2500 Hz split — if split 1's HP still
    // ran, the sum would lose ~3 dB instead of staying allpass-flat.
    const peak = runSine(h, 3000, 1.0);
    expect(peak).toBeCloseTo(0.5, 1);
  });

  it("a network switched 3-band → 2-band matches one configured 2-band from scratch", () => {
    const hSwitched = makeNetwork(3);
    hSwitched.xover.setFrequency(0, 250, SR);
    hSwitched.xover.setFrequency(1, 2500, SR);
    runSine(hSwitched, 3000, 0.5);
    hSwitched.xover.setBandCount(2);

    const hFresh = makeNetwork(2);
    hFresh.xover.setFrequency(0, 250, SR);

    // Compare band levels (high band especially) after identical stimulus.
    const switchedPeak = runSine(hSwitched, 3000, 1.0);
    const freshPeak = runSine(hFresh, 3000, 1.0);
    expect(Math.abs(switchedPeak - freshPeak)).toBeLessThan(0.01);
  });

  it("hybrid (FIR) mode: switching 3-band → 2-band keeps perfect reconstruction", () => {
    const h = makeNetwork(3);
    h.xover.setCrossoverMode("hybrid");
    h.xover.setFrequency(0, 250, SR);
    h.xover.setFrequency(1, 2500, SR);
    runSine(h, 3000, 0.5);
    h.xover.setBandCount(2);
    const peak = runSine(h, 3000, 1.0);
    expect(peak).toBeCloseTo(0.5, 1);
  });
});
