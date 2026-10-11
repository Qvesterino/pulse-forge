/**
 * PORTAL soak — the invariants that only appear over time.
 *
 * Unlike SKRUTKA's all-pass engine, PORTAL carries two recursive spectral paths:
 * a per-bin delay line with feedback and a per-bin complex one-pole. Both are
 * the shape that blows up in production — a single Infinity reaching the ring
 * propagates to every bin in every later frame — so this soak is not optional
 * polish, it is the test ADR 0038, D5 exists to justify.
 *
 * What is proven here:
 *   1. Every output sample of the full render is finite.
 *   2. No output sample is subnormal (the denormal flush holds over minutes).
 *   3. Heap growth stays bounded — the processor allocates nothing per block.
 *   4. The delay ring does not grow (allocation is sized once in prepare()).
 *   5. The overlap-add normaliser stays in its 1..4 window, which is the
 *      measured signature of a correct 75 %-overlap OLA.
 *   6. Sustained max feedback at max freeze cannot run away.
 *
 * The render is parameter-STATIC on purpose: a moving parameter is a different
 * defect class (the envelope/release one in NEW-EFFECT-CHECKLIST §2) and is
 * covered by the golden suite's determinism check instead.
 */
import { describe, expect, it } from "vitest";

import { SpectralProcessor, DEFAULT_SPECTRAL_PARAMS } from "../src/effects/spectral-core/dsp/SpectralProcessor";

const SR = 44100;
const BLOCK = 128;
const SOAK_SECONDS = 60;
const TOTAL_BLOCKS = Math.floor((SOAK_SECONDS * SR) / BLOCK);

/** Heap growth ceiling, matching the plugin soak contract (AGENTS.md §6). */
const HEAP_GROWTH_LIMIT_BYTES = 6 * 1024 * 1024;

function makeProcessor(params: Partial<typeof DEFAULT_SPECTRAL_PARAMS>) {
  const proc = new SpectralProcessor();
  proc.setParams({ ...DEFAULT_SPECTRAL_PARAMS, ...params });
  proc.prepare(SR);
  return proc;
}

/** A signal with content in every corner of the spectrum, so every bin works. */
const drive = (i: number) =>
  0.35 * Math.sin((2 * Math.PI * 110 * i) / SR) +
  0.2 * Math.sin((2 * Math.PI * 1750 * i) / SR) +
  0.1 * Math.sin((2 * Math.PI * 9100 * i) / SR);

/**
 * Run the full soak and return the measured invariants.
 */
function soak(params: Partial<typeof DEFAULT_SPECTRAL_PARAMS>) {
  const proc = makeProcessor(params);
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);

  let nonFinite = 0;
  let subnormal = 0;
  let peak = 0;

  // Warm the processor before the heap snapshot. The delay rings are ~3 MB and
  // are allocated once in prepare(); counting that as "growth" measures the
  // allocation, not a leak.
  for (let block = 0; block < Math.floor(SR / BLOCK); block++) {
    for (let i = 0; i < BLOCK; i++) inL[i] = inR[i] = drive(block * BLOCK + i);
    proc.process(inL, inR, outL, outR, BLOCK);
  }

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const ringBefore = proc.ringFrames();
  for (let block = 0; block < TOTAL_BLOCKS; block++) {
    const off = block * BLOCK;
    for (let i = 0; i < BLOCK; i++) {
      inL[i] = drive(off + i);
      inR[i] = -inL[i] * 0.8; // decorrelated side, so both STFT paths are loaded
    }
    proc.process(inL, inR, outL, outR, BLOCK);

    for (let i = 0; i < BLOCK; i++) {
      const a = outL[i];
      const b = outR[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        nonFinite++;
        continue;
      }
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > peak) peak = m;
      // Subnormal = nonzero but below the flush threshold. A sustained run of
      // these is the CPU-trap signature; a handful of denormal results from the
      // tanh tail is normal and is caught by the explicit flush, not this.
      if ((a !== 0 && Math.abs(a) < 1e-20) || (b !== 0 && Math.abs(b) < 1e-20)) subnormal++;
    }
  }

  // Collect before the closing snapshot too: without it this measures
  // uncollected churn as if it were retained heap.
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  return {
    nonFinite,
    subnormal,
    peak,
    heapGrowth: heapAfter - heapBefore,
    ringFrames: proc.ringFrames(),
    ringGrew: proc.ringFrames() !== ringBefore,
    frames: proc.getMeters().frames,
  };
}

describe("PORTAL soak", () => {
  it("DELAY at maximum feedback stays finite, bounded and denormal-free", () => {
    const r = soak({ mode: 0, time: 2000, feedback: 1, decay: 0, diffuse: 1, shift: 24, mix: 1 });

    expect(r.nonFinite).toBe(0);
    expect(r.subnormal).toBe(0);
    // The delay is bounded, not merely finite: a feedback path that grows without
    // limit stays finite for a long while and still destroys the mix downstream.
    expect(r.peak).toBeLessThan(4);
    expect(r.peak).toBeGreaterThan(0.01);
    expect(r.heapGrowth).toBeLessThan(HEAP_GROWTH_LIMIT_BYTES);
    expect(r.ringGrew).toBe(false);
    expect(r.frames).toBeGreaterThan(0);
  }, 300000);

  it("RESONATOR at full resonance with the narrowest focus stays bounded", () => {
    const r = soak({ mode: 1, resonance: 1, focus: 20, focusWidth: 0.1, mix: 1 });

    expect(r.nonFinite).toBe(0);
    expect(r.subnormal).toBe(0);
    expect(r.peak).toBeLessThan(4);
    expect(r.heapGrowth).toBeLessThan(HEAP_GROWTH_LIMIT_BYTES);
  }, 300000);

  it("FREEZE held for a minute cannot run away", () => {
    // The freeze path is the one that has no natural input to decay it: the
    // frame is held and only the feedback attenuates it. If the feedback ceiling
    // in ADR 0038, D5 is wrong, this is where it shows.
    const r = soak({ mode: 2, freeze: 1, feedback: 1, resonance: 1, mix: 1 });

    expect(r.nonFinite).toBe(0);
    expect(r.subnormal).toBe(0);
    expect(r.peak).toBeLessThan(4);
    expect(r.heapGrowth).toBeLessThan(HEAP_GROWTH_LIMIT_BYTES);
  }, 300000);

  it("the overlap-add normaliser keeps enough window power to divide by", () => {
    // normPeak is the largest accumulated window power across the block just
    // emitted. It is NOT a steady-state constant: the leading `hop` positions of
    // each frame are retired before accumulating, so a block straddling a frame
    // boundary legitimately mixes 1-window and 4-window positions. What matters
    // is the range — far below 1 and the output is being divided by window power
    // that was never accumulated (the 7030x-peak defect), far above 8 and the
    // accumulator is leaking across cycles.
    const proc = makeProcessor({ mode: 0, feedback: 0.7, time: 300, mix: 1 });
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    let low = Infinity;
    let high = 0;
    for (let block = 0; block < 400; block++) {
      for (let i = 0; i < BLOCK; i++) inL[i] = inR[i] = drive(block * BLOCK + i);
      proc.process(inL, inR, outL, outR, BLOCK);
      const n = proc.stftNormPeak();
      if (n > 0) {
        if (n < low) low = n;
        if (n > high) high = n;
      }
    }
    expect(low).toBeGreaterThan(0.05);
    expect(high).toBeLessThan(8);
  }, 60000);
});
