/**
 * Ultina hardening regression suite #2 — one test per confirmed defect fixed
 * in the 2026-09-12 deep-audit pass. Each test pins the FIXED behavior and
 * fails on the pre-fix code path.
 *
 * Covered:
 *  1. multiband: 3-band ANALOG LR4 ran split1.lp twice per block (the dead
 *     in-loop LP pass advanced the biquad state, then the post-loop mid-band
 *     refinement re-filtered the same data) — mid band and the flat-sum
 *     reconstruction were corrupted (measured deviation 0.76 on transients).
 *  2. UltinaProcessor: a single non-finite input frame no longer permanently
 *     poisons inline filter recursions (sculptor/unmask bells, LUFS
 *     K-weight, spectral-registry envelopes) — input scrub + per-site
 *     non-finite state guards.
 *  3. exciter/clipper: M/S channel mode + bandCount 1 delivered a length-1
 *     bandChannels array; chR aliased chL so saturation/tone/knee ran twice
 *     over the same buffer (and polluted the R tone state).
 *  4. eq: dynamicTilt (shape 11) never designed filter2 — after any tilt
 *     (shape 6) configuration the band kept the stale high-shelf forever.
 *  5. phase: re-enabling the module replayed up to 50 ms of pre-disable
 *     audio from the frozen time-shift delay ring.
 *  6. comp: bands above the active band count kept reporting stale
 *     gain-reduction meters after a band-count reduction.
 */
import { describe, expect, it } from "vitest";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";
import { CrossoverNetwork, LR4_Q } from "../src/effects/ultina-core/dsp/multiband.js";
import {
  createBiquad,
  setHighPass,
  setLowPass,
  processBiquadChannel,
} from "../src/effects/ultina-core/dsp/primitives.js";
import { LufsMeter } from "../src/effects/ultina-core/dsp/lufsMeter.js";
import { ExciterModuleProcessor } from "../src/effects/ultina-core/dsp/modules/exciterModule.js";
import { ClipperModuleProcessor } from "../src/effects/ultina-core/dsp/modules/clipperModule.js";
import { EqModuleProcessor } from "../src/effects/ultina-core/dsp/modules/eqModule.js";
import { SculptorModuleProcessor } from "../src/effects/ultina-core/dsp/modules/sculptorModule.js";
import { CompModuleProcessor } from "../src/effects/ultina-core/dsp/modules/compModule.js";
import { buildDefaultParams } from "../src/effects/ultina-core/contracts/parameterSchema.js";
import type { ModuleProcessorContext } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";

const SR = 48000;
const BLOCK = 128;

function ctx(): ModuleProcessorContext {
  return { sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 };
}

function moduleParams(overrides: Record<string, number>): Record<string, number> {
  return { ...buildDefaultParams(), ...overrides };
}

/** Mono-content stereo block: identical L/R (M/S decode then keeps L' = M'). */
function identicalSineBlock(blockIndex: number, freq: number, amp: number): Float32Array[] {
  const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let i = 0; i < BLOCK; i++) {
    const t = (blockIndex * BLOCK + i) / SR;
    const v = amp * Math.sin(2 * Math.PI * freq * t);
    chans[0][i] = v;
    chans[1][i] = v;
  }
  return chans;
}

function blockRms(chans: Float32Array[]): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += chans[0][i] * chans[0][i];
  return Math.sqrt(sum / BLOCK);
}

function blockPeak(chans: Float32Array[]): number {
  let peak = 0;
  for (let i = 0; i < BLOCK; i++) {
    const a = Math.abs(chans[0][i]);
    if (a > peak) peak = a;
  }
  return peak;
}

// ═══════════════════════════════════════════════════════════
// 1. 3-band analog LR4 mid band: single-pass reference
// ═══════════════════════════════════════════════════════════

describe("multiband: 3-band analog LR4 mid band (double-filter regression)", () => {
  it("mid band matches an independent single-pass HP0→LP1 cascade", () => {
    const xover = new CrossoverNetwork();
    xover.prepare(2, 3, BLOCK);
    xover.setFrequency(0, 250, SR);
    xover.setFrequency(1, 2500, SR);
    const bandOut: Float32Array[][] = [];
    for (let b = 0; b < 3; b++) {
      bandOut.push([new Float32Array(BLOCK), new Float32Array(BLOCK)]);
    }

    // Independent reference: two cascaded HP @250 then two cascaded LP @2500
    // (exactly what the post-loop refinement should compute ONCE).
    const refFilters: ReturnType<typeof createBiquad>[][] = [];
    for (let ch = 0; ch < 2; ch++) {
      const hp0 = createBiquad(1);
      const hp1 = createBiquad(1);
      setHighPass(hp0.coeffs, 250, LR4_Q, SR);
      setHighPass(hp1.coeffs, 250, LR4_Q, SR);
      const lp0 = createBiquad(1);
      const lp1 = createBiquad(1);
      setLowPass(lp0.coeffs, 2500, LR4_Q, SR);
      setLowPass(lp1.coeffs, 2500, LR4_Q, SR);
      refFilters.push([hp0, hp1, lp0, lp1]);
    }

    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let maxDiff = 0;
    const totalBlocks = 40;
    for (let blk = 0; blk < totalBlocks; blk++) {
      for (let i = 0; i < BLOCK; i++) {
        const t = (blk * BLOCK + i) / SR;
        // Mid-band tones + a click every 4th block to excite filter state.
        const v = 0.5 * Math.sin(2 * Math.PI * 800 * t) + 0.3 * Math.sin(2 * Math.PI * 2000 * t);
        input[0][i] = i === 0 && blk % 4 === 0 ? 1 : v;
        input[1][i] = input[0][i];
      }
      xover.split(input, bandOut, BLOCK, SR);

      const ref = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let ch = 0; ch < 2; ch++) {
        ref[ch].set(input[ch]);
        for (const bq of refFilters[ch]) {
          processBiquadChannel(bq, ref[ch], 0, BLOCK);
        }
      }
      for (let i = 0; i < BLOCK; i++) {
        const d = Math.abs(bandOut[1][0][i] - ref[0][i]);
        if (d > maxDiff) maxDiff = d;
      }
    }
    // Pre-fix the double-filtered mid band deviated by up to 0.76 amplitude
    // from this reference. Post-fix the math is identical (measured 0).
    expect(maxDiff).toBeLessThan(1e-9);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Non-finite input: state poisoning + recovery
// ═══════════════════════════════════════════════════════════

describe("non-finite input guard: one NaN frame must not kill the DSP", () => {
  it("processor output recovers after a NaN-contaminated block (input scrub)", () => {
    const proc = new UltinaProcessor();
    registerCoreModules(proc);
    proc.prepare({ sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
    proc.getGraphRuntime().setModuleEnabled("sculptor", true);
    proc.setParameter("sculptor.enabled", 1);
    proc.setParameter("sculptor.amount", 60);

    const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const run = (injectNan: boolean) => {
      for (let i = 0; i < BLOCK; i++) {
        const t = i / SR;
        const v = 0.4 * Math.sin(2 * Math.PI * 500 * t);
        chans[0][i] = v;
        chans[1][i] = v;
      }
      if (injectNan) {
        chans[0][3] = NaN;
        chans[1][3] = Infinity;
      }
      proc.process(chans, BLOCK);
    };

    for (let b = 0; b < 10; b++) run(false);
    run(true); // poisoned block
    for (let b = 0; b < 10; b++) run(false);

    // Output stays finite AND audible — pre-fix the sculptor wet path
    // collapsed to permanent silence (NaN state, zeroed by the final
    // sanitizer, never self-healing).
    for (let i = 0; i < BLOCK; i++) {
      expect(Number.isFinite(chans[0][i])).toBe(true);
      expect(Number.isFinite(chans[1][i])).toBe(true);
    }
    expect(blockRms(chans)).toBeGreaterThan(0.05);
  });

  it("sculptor module recovers from a poisoned bell-filter state (per-site guard)", () => {
    const mod = new SculptorModuleProcessor();
    mod.prepare(ctx());
    const params = moduleParams({
      "sculptor.enabled": 1,
      "sculptor.amount": 70,
      "sculptor.dryWet": 100,
    });

    const bad = identicalSineBlock(0, 500, 0.4);
    bad[0][11] = NaN;
    // Direct module call bypasses the processor-level input scrub — only
    // the per-site non-finite state guards protect this path.
    mod.process({ channels: bad, frameCount: BLOCK, sidechain: null, ctx: ctx(), params });

    for (let b = 0; b < 8; b++) {
      const chans = identicalSineBlock(b + 1, 500, 0.4);
      mod.process({ channels: chans, frameCount: BLOCK, sidechain: null, ctx: ctx(), params });
      expect(blockPeak(chans)).toBeGreaterThan(0.05); // wet path survived
    }
  });

  it("LUFS meter recovers after a non-finite block (K-weight + window guard)", () => {
    const meter = new LufsMeter();
    meter.prepare(SR, BLOCK);
    const bad = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    bad[0][7] = NaN;
    meter.process(bad[0], bad[1], BLOCK);

    const good = identicalSineBlock(0, 997, 0.5);
    for (let b = 0; b < 100; b++) {
      meter.process(good[0], good[1], BLOCK);
    }
    const st = meter.getShortTermLufs();
    expect(Number.isFinite(st)).toBe(true);
    // A 0.5-amp sine sits far above the absolute gate; pre-fix every
    // reading stayed NaN forever after the poisoned block.
    expect(st).toBeGreaterThan(-30);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. M/S + single band: exciter/clipper mono aliasing
// ═══════════════════════════════════════════════════════════

describe("exciter: mid channel mode, single band (mono aliasing regression)", () => {
  it("identical L/R content matches stereo-mode output exactly (tone applied once)", () => {
    // Linear-region oracle: all saturation amounts 0 (applySaturation early-
    // returns) and only the tone filter active. The M/S path is orthonormal
    // (1/√2), which a LINEAR chain commutes with exactly — so mid mode must
    // equal stereo mode bit-closely. Pre-fix the aliased chR pass ran the
    // tone filter over the already-filtered buffer (tone² response).
    const run = (channelMode: number): Float32Array[] => {
      const mod = new ExciterModuleProcessor();
      mod.prepare(ctx());
      const params = moduleParams({
        "exciter.enabled": 1,
        "exciter.bandCount": 1,
        "exciter.channelMode": channelMode,
        "exciter.oversampling": 0,
        "exciter.toneSlider": 50,
        "exciter.tubeAmount": 0,
        "exciter.tubeAsymAmount": 0,
        "exciter.warmAmount": 0,
        "exciter.tapeAmount": 0,
        "exciter.retroAmount": 0,
        "exciter.overdriveAmount": 0,
        "exciter.screamAmount": 0,
        "exciter.clipperAmount": 0,
        "exciter.scratchAmount": 0,
        "exciter.mix": 100,
      });
      let last: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let b = 0; b < 12; b++) {
        last = identicalSineBlock(b, 1200, 0.4);
        mod.process({ channels: last, frameCount: BLOCK, sidechain: null, ctx: ctx(), params });
      }
      return last;
    };

    const stereo = run(0);
    const mid = run(1);
    let maxDiff = 0;
    for (let i = 0; i < BLOCK; i++) {
      const d = Math.abs(stereo[0][i] - mid[0][i]);
      if (d > maxDiff) maxDiff = d;
    }
    // Pre-fix: the squared tone response deviated by >1e-2.
    expect(maxDiff).toBeLessThan(1e-7);
  });
});

describe("clipper: mid channel mode, single band (mono aliasing regression)", () => {
  it("identical L/R content matches stereo-mode output exactly (drive applied once)", () => {
    // Linear-region oracle: a signal far below the knee is pure drive gain —
    // linear, so the orthonormal M/S round-trip commutes exactly. Pre-fix
    // the aliased R pass applied the drive twice (v·drive² vs v·drive).
    const run = (channelMode: number): Float32Array[] => {
      const mod = new ClipperModuleProcessor();
      mod.prepare(ctx());
      const params = moduleParams({
        "clipper.enabled": 1,
        "clipper.bandCount": 1,
        "clipper.channelMode": channelMode,
        "clipper.oversampling": 0,
        "clipper.driveDb": 12,
        "clipper.ceilingDb": 0,
        // Keep the oracle in the genuinely linear region. With a 6 dB knee
        // this implementation's knee starts around 0.004 linear, so even
        // this small test tone would intentionally exercise the nonlinear
        // curve and M/S amplitude normalization would be a different test.
        "clipper.kneeDb": 0,
        "clipper.mix": 100,
      });
      let last: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let b = 0; b < 12; b++) {
        last = identicalSineBlock(b, 300, 0.01); // |drive·x| ≈ 0.04 << kneeStart
        mod.process({ channels: last, frameCount: BLOCK, sidechain: null, ctx: ctx(), params });
      }
      return last;
    };

    const stereo = run(0);
    const mid = run(1);
    let maxDiff = 0;
    for (let i = 0; i < BLOCK; i++) {
      const d = Math.abs(stereo[0][i] - mid[0][i]);
      if (d > maxDiff) maxDiff = d;
    }
    // Pre-fix: drive² vs drive ≈ 0.12 difference at these settings.
    expect(maxDiff).toBeLessThan(1e-7);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. EQ dynamicTilt: stale filter2 coefficients
// ═══════════════════════════════════════════════════════════

describe("eq: dynamicTilt after a tilt configuration (stale filter2 regression)", () => {
  it("a band switched tilt → dynamicTilt matches a fresh dynamicTilt band", () => {
    const run = (warmUpWithTilt: boolean): number => {
      const mod = new EqModuleProcessor();
      mod.prepare(ctx());
      const params = moduleParams({
        "eq.enabled": 1,
        "eq.band0.enabled": 1,
        "eq.band0.freqHz": 1000,
        "eq.band0.gainDb": 9,
        "eq.band0.q": 1,
        // Isolate the stale filter2 coefficient contract from envelope
        // history: the comparison is about the static dynamicTilt pair,
        // not about a 12-block difference in dynamic gain warm-up.
        "eq.band0.dynamicRangeDb": 0,
      });
      const blocks = 220;
      let rmsSum = 0;
      let counted = 0;
      for (let b = 0; b < blocks; b++) {
        params["eq.band0.shape"] = warmUpWithTilt && b < 12 ? 6 : 11;
        const chans = identicalSineBlock(b, 1500, 0.4);
        mod.process({ channels: chans, frameCount: BLOCK, sidechain: null, ctx: ctx(), params });
        // Measure only after the ~10 ms coefficient glide from the tilt
        // shelves to the 0 dB pair has fully settled.
        if (b >= 200) {
          rmsSum += blockRms(chans);
          counted++;
        }
      }
      return rmsSum / counted;
    };

    const fromFresh = run(false);
    const afterTilt = run(true);
    // Pre-fix: the tilt configuration left a +4.5 dB high shelf in filter2
    // that dynamicTilt never redesigned — a large static difference.
    expect(Math.abs(afterTilt - fromFresh)).toBeLessThan(1e-6);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Phase: stale delay-line replay on re-enable
// ═══════════════════════════════════════════════════════════

describe("phase: re-enable clears the time-shift delay ring", () => {
  it("silence after re-enable stays silent (no pre-disable replay)", () => {
    const proc = new UltinaProcessor();
    registerCoreModules(proc);
    proc.prepare({ sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 });
    proc.getGraphRuntime().setModuleEnabled("phase", true);
    proc.setParameter("phase.enabled", 1);
    proc.setParameter("phase.timeShiftMs", 10);

    // Fill the delay ring with loud material.
    const loud = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < 30; b++) {
      for (let i = 0; i < BLOCK; i++) {
        const t = (b * BLOCK + i) / SR;
        const v = 0.6 * Math.sin(2 * Math.PI * 440 * t);
        loud[0][i] = v;
        loud[1][i] = v;
      }
      proc.process(loud, BLOCK);
    }

    // Toggle off, wait (module frozen out of the chain), toggle on.
    proc.setParameter("phase.enabled", 0);
    proc.getGraphRuntime().setModuleEnabled("phase", false);
    proc.setParameter("phase.enabled", 1);
    proc.getGraphRuntime().setModuleEnabled("phase", true);

    // Digital silence in must produce silence out — pre-fix the first
    // delayL samples replayed the pre-disable sine (peak ≈ 0.6).
    const silence = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process(silence, BLOCK);
    expect(blockPeak(silence)).toBeLessThan(1e-6);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. comp: stale meters for bands above the active count
// ═══════════════════════════════════════════════════════════

describe("comp: band-count reduction clears stale band meters", () => {
  it("bands ≥ the new count report zero GR after 3 → 1 switch", () => {
    const mod = new CompModuleProcessor();
    mod.prepare(ctx());
    const params = moduleParams({
      "comp.enabled": 1,
      "comp.bandCount": 3,
      "comp.thresholdDb": -40,
      "comp.ratio": 8,
    });
    // Deep compression across all 3 bands.
    for (let b = 0; b < 30; b++) {
      const chans = identicalSineBlock(b, 440, 0.8);
      mod.process({ channels: chans, frameCount: BLOCK, sidechain: null, ctx: ctx(), params });
    }
    const before = mod.getMeters() as { gainReduction: number[] };
    const grBefore = [...before.gainReduction];
    expect(Math.max(...grBefore)).toBeGreaterThan(1); // compression is happening

    params["comp.bandCount"] = 1;
    for (let b = 0; b < 8; b++) {
      const chans = identicalSineBlock(b + 30, 440, 0.8);
      mod.process({ channels: chans, frameCount: BLOCK, sidechain: null, ctx: ctx(), params });
    }
    const after = mod.getMeters() as { gainReduction: number[] };
    expect(after.gainReduction[0]).toBeGreaterThan(0); // active band still reports
    // Pre-fix: bands 1–2 kept their pre-switch GR readings frozen.
    expect(after.gainReduction[1]).toBe(0);
    expect(after.gainReduction[2]).toBe(0);
  });
});
