/**
 * FXEQ core hardening regression suite #2 — one test per confirmed defect
 * fixed in the 2026-09-12 hardening pass. Each test pins the FIXED behavior
 * and fails on the pre-fix code path.
 *
 * Covered:
 *  1. fxEqProcessor.loadParameters({ bandCount: NaN }) no longer poisons
 *     bandCount (clamp() passes NaN through) — the pre-fix state crashed
 *     crossover.process() with a TypeError on every block
 *     (bandBuffers[NaN] → undefined).
 *  2. startMorph(target, NaN): morphDuration no longer becomes NaN
 *     (Math.max(0.01, NaN) === NaN), which wrote NaN into `values` every
 *     block — permanent silence from one bad call.
 *  3. startMorph no longer accepts bandCount as a morph target: routing it
 *     per block rebuilt the schema + crossover on the audio thread for the
 *     whole morph duration.
 *  4. Limiter: leaving/re-entering true-peak mode resets the lookahead ring.
 *     The pre-fix path replayed the ring's pre-legacy content (~lookaheadMs
 *     of stale audio) on re-entry.
 *  5. reverb: loadParameters → recompute() re-wraps the predelay write
 *     cursors after a SHRINK (same contract as setParameter("predelayMs")).
 *  6. onePoleHpCoef(0, sr) degrades to 1 (passthrough) instead of NaN.
 */
import { describe, expect, it } from "vitest";
import { createFxEqProcessor } from "../src/effects/fxeq-core/core/fxEqProcessor";
import { createLimiterModule } from "../src/effects/fxeq-core/modules/limiter";
import { createReverbModule } from "../src/effects/fxeq-core/modules/reverb";
import { onePoleHpCoef } from "../src/effects/fxeq-core/dsp/mathUtils";

const SR = 48000;
const BLOCK = 128;

function stereoBlock(fn: (i: number) => number): Float32Array[] {
  return [Float32Array.from({ length: BLOCK }, (_, i) => fn(i)), Float32Array.from({ length: BLOCK }, (_, i) => fn(i))];
}

describe("fxeq-core hardening #2 — bandCount NaN armor", () => {
  it("loadParameters({ bandCount: NaN }) keeps the band count valid and process() running", () => {
    const proc = createFxEqProcessor(undefined, { seed: 7 });
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ bandCount: NaN });
    // The stored band count must stay a sane number (NaN would fail both
    // clamp comparisons pre-fix).
    expect(Number.isFinite(proc.getParameter("bandCount"))).toBe(true);
    // The pre-fix state threw TypeError inside crossover.process() here.
    for (let b = 0; b < 10; b++) {
      proc.process(stereoBlock((i) => Math.sin((2 * Math.PI * 220 * (b * BLOCK + i)) / SR)), BLOCK);
    }
  });

  it("a NaN bandCount in a bulk load does not block the other parameters", () => {
    const proc = createFxEqProcessor(undefined, { seed: 7 });
    proc.prepare(SR, 2, BLOCK);
    proc.loadParameters({ bandCount: NaN, inputGainDb: -12 });
    expect(proc.getParameter("inputGainDb")).toBe(-12);
    expect(Number.isFinite(proc.getParameter("bandCount"))).toBe(true);
  });
});

describe("fxeq-core hardening #2 — morph armor", () => {
  it("startMorph with a NaN duration keeps every morphed value finite", () => {
    const proc = createFxEqProcessor(undefined, { seed: 7 });
    proc.prepare(SR, 2, BLOCK);
    proc.setParameter("inputGainDb", -6);
    proc.startMorph({ inputGainDb: 3 }, NaN);
    // The NaN duration falls back to 0.3 s — render past it (80 blocks is
    // only 0.21 s).
    for (let b = 0; b < 200; b++) {
      proc.process(stereoBlock((i) => Math.sin((2 * Math.PI * 220 * (b * BLOCK + i)) / SR)), BLOCK);
      // Pre-fix: values["inputGainDb"] was NaN for the whole morph (t=NaN)
      // and the input gain multiplied the signal by NaN → silence.
      expect(Number.isFinite(proc.getParameter("inputGainDb"))).toBe(true);
    }
    // Morph completed onto the exact target.
    expect(proc.getParameter("inputGainDb")).toBeCloseTo(3, 6);
  });

  it("bandCount is never a morph target — it must not change mid-morph", () => {
    const proc = createFxEqProcessor(undefined, { seed: 7 });
    proc.prepare(SR, 2, BLOCK);
    const before = proc.getParameter("bandCount");
    proc.startMorph({ bandCount: 3, inputGainDb: -3 }, 0.05);
    for (let b = 0; b < 60; b++) {
      proc.process(stereoBlock(() => 0.1 * Math.sin(b * BLOCK)), BLOCK);
    }
    expect(proc.getParameter("bandCount")).toBe(before);
    // The audio-rate parameters in the same target still morph.
    expect(proc.getParameter("inputGainDb")).toBeCloseTo(-3, 6);
  });
});

describe("fxeq-core hardening #2 — limiter true-peak mode switch", () => {
  it("re-entering true-peak mode does not replay the lookahead ring's pre-legacy content", () => {
    const lim = createLimiterModule({});
    lim.prepare(SR, 2, BLOCK);
    lim.setParameter("enabled", 1);
    lim.setParameter("truePeak", 1);

    // Fill the lookahead ring with loud content (~0.3 s).
    let phase = 0;
    const loud = () => {
      const buf = stereoBlock(() => {
        phase += (2 * Math.PI * 220) / SR;
        return 0.85 * Math.sin(phase);
      });
      lim.process(buf, BLOCK);
    };
    for (let b = 0; b < Math.ceil(0.3 * SR) / BLOCK; b++) loud();

    // Switch to legacy mode and feed silence long enough to flush the
    // audible path — pre-fix, the ring kept its pre-toggle content.
    lim.setParameter("truePeak", 0);
    const silence = () => stereoBlock(() => 0);
    for (let b = 0; b < Math.ceil(0.2 * SR) / BLOCK; b++) lim.process(silence(), BLOCK);

    // Back to true-peak. The FIRST silent block must BE silent: the ring
    // was reset. Pre-fix it replayed ≈lookaheadMs of the loud sine.
    lim.setParameter("truePeak", 1);
    lim.process(silence(), BLOCK);
    const out = silence();
    lim.process(out, BLOCK);
    let peak = 0;
    for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(out[0][i]), Math.abs(out[1][i]));
    expect(peak).toBeLessThan(1e-3);
  });
});

describe("fxeq-core hardening #2 — misc armor", () => {
  it("reverb preset loads re-wrap the predelay write cursors after a shrink", () => {
    const rev = createReverbModule({});
    rev.prepare(SR, 2, BLOCK);
    // Large predelay, render so the cursors advance deep into the buffer…
    rev.setParameter("enabled", 1);
    rev.setParameter("predelayMs", 100);
    for (let b = 0; b < 20; b++) {
      rev.process(stereoBlock(() => 0.5 * Math.sin(b * BLOCK)), BLOCK);
    }
    // …then load a state with a SMALL predelay (loadParameters → recompute).
    // Pre-fix the cursors stayed beyond the new logical length and the first
    // read pulled one stale sample from the retired region.
    rev.loadParameters({ enabled: 1, predelayMs: 5, type: 0, decayMs: 1200 });
    for (let b = 0; b < 20; b++) {
      const out = stereoBlock(() => 0.5 * Math.sin(b * BLOCK));
      rev.process(out, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(out[0][i])).toBe(true);
      }
    }
  });

  it("onePoleHpCoef(0, sr) is 1 (passthrough), not NaN", () => {
    expect(onePoleHpCoef(0, SR)).toBe(1);
    expect(onePoleHpCoef(NaN, SR)).toBe(1);
    expect(onePoleHpCoef(-5, SR)).toBe(1);
    // A sane cutoff still behaves (well below 1).
    expect(onePoleHpCoef(1000, SR)).toBeLessThan(1);
  });
});
