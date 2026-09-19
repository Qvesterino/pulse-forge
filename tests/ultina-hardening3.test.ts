/**
 * Ultina hardening regression suite #3 — one test per confirmed defect fixed
 * in the 2026-09-12 hardening pass. Each test pins the FIXED behavior and
 * fails on the pre-fix code path.
 *
 * Covered:
 *  1. designLowPassFir clamps the normalized cutoff below Nyquist. The
 *     hybrid crossover's FIR splitter previously accepted fc >= 0.5
 *     (reachable at low session rates, since module params clamp only to
 *     20..20000 Hz) — the sinc collapsed toward a delta/mirrored response
 *     and the bands stopped splitting.
 *  2. clipper: bands above the active band count reset their meter slots on
 *     a band-count reduction (getMeters publishes the full 3-slot arrays).
 *  3. LufsMeter.prepare() resets the unfed/stale tracking (a re-prepare
 *     while the stale flag was armed used to report silence until the whole
 *     window turned over).
 *  4. UltinaProcessor: bypassed time is noted to the LUFS meter when
 *     metering is gated off but gain-match is on — auto-gain no longer
 *     integrates against a pre-bypass short-term loudness after unbypass.
 *  5. phase: the sidechain cross-correlation indexes the sidechain at the
 *     chunk's absolute position, so multi-chunk host blocks (> maxBlockSize)
 *     correlate against their OWN window, not the first chunk's.
 *  6. Audio-path dry/sidechain copies (processor + comp/gate/transient +
 *     multiband splits) are scalar loops — output identical (pinned by the
 *     golden vectors), allocation-free as the realtime constraints require.
 */
import { describe, expect, it } from "vitest";
import { createFirFilter, designLowPassFir, type FirFilterState } from "../src/effects/ultina-core/dsp/primitives.js";
import { ClipperModuleProcessor } from "../src/effects/ultina-core/dsp/modules/clipperModule.js";
import { PhaseModuleProcessor } from "../src/effects/ultina-core/dsp/modules/phaseModule.js";
import { UltinaProcessor } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";
import { LufsMeter } from "../src/effects/ultina-core/dsp/lufsMeter.js";
import { registerCoreModules } from "../src/effects/ultina-core/dsp/moduleFactories.js";
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

/** |H(ω)| of a symmetric FIR at normalized frequency f (cycles/sample). */
function firMagnitude(fir: FirFilterState, f: number): number {
  const M = (fir.length - 1) / 2;
  let re = 0;
  let im = 0;
  for (let n = 0; n < fir.length; n++) {
    const angle = -2 * Math.PI * f * (n - M);
    re += fir.taps[n] * Math.cos(angle);
    im += fir.taps[n] * Math.sin(angle);
  }
  return Math.hypot(re, im);
}

describe("ultina hardening #3 — hybrid FIR cutoff clamp", () => {
  it("a cutoff requested above Nyquist still designs a working low-pass", () => {
    // 8000 Hz session rate, 6000 Hz crossover (fc = 0.75 unclamped — the
    // comp/gate/… modules clamp crossover freq only to the schema's
    // 20..20000 Hz).
    const fir = createFirFilter(63);
    designLowPassFir(fir, 6000, 8000, 63);
    for (const t of fir.taps) expect(Number.isFinite(t)).toBe(true);
    // Passband preserved…
    expect(firMagnitude(fir, 0.2)).toBeGreaterThan(0.85);
    // …and the -6 dB region actually attenuates (pre-fix fc = 0.75 made
    // |H| ≈ 1 across the entire representable band).
    expect(firMagnitude(fir, 0.495)).toBeLessThan(0.85);
  });

  it("a zero cutoff degrades to the passband floor instead of NaN taps", () => {
    const fir = createFirFilter(31);
    designLowPassFir(fir, 0, SR, 31);
    for (const t of fir.taps) expect(Number.isFinite(t)).toBe(true);
  });
});

describe("ultina hardening #3 — clipper stale meter slots", () => {
  it("reducing the band count clears the retired bands' meter slots", () => {
    const mod = new ClipperModuleProcessor();
    mod.prepare(ctx());
    const params = moduleParams({
      "clipper.enabled": 1,
      "clipper.bandCount": 3,
      "clipper.channelMode": 0,
      "clipper.oversampling": 0,
      "clipper.driveDb": 12,
      "clipper.ceilingDb": 0,
      "clipper.kneeDb": 0,
      "clipper.mix": 100,
    });
    const loud = (b: number): Float32Array[] => {
      const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let i = 0; i < BLOCK; i++) {
        const v = 0.9 * Math.sin((2 * Math.PI * 200 * (b * BLOCK + i)) / SR);
        chans[0][i] = v;
        chans[1][i] = v;
      }
      return chans;
    };
    for (let b = 0; b < 32; b++) {
      mod.process({ channels: loud(b), frameCount: BLOCK, sidechain: null, ctx: ctx(), params });
    }
    const before = mod.getMeters() as { bands: { inputPeakDb: number }[] };
    expect(before.bands.length).toBe(3);
    // Bands 1/2 actually measured something in 3-band mode…
    expect(before.bands[1].inputPeakDb).toBeGreaterThan(-200);
    // …then the band count drops to 1: slots 1/2 must reset, not freeze.
    const reduced = moduleParams({ ...params, "clipper.bandCount": 1 });
    for (let b = 0; b < 8; b++) {
      mod.process({ channels: loud(b), frameCount: BLOCK, sidechain: null, ctx: ctx(), params: reduced });
    }
    const after = mod.getMeters() as { bands: { inputPeakDb: number }[] };
    expect(after.bands[1].inputPeakDb).toBe(-200);
    expect(after.bands[2].inputPeakDb).toBe(-200);
  });
});

describe("ultina hardening #3 — LUFS stale tracking", () => {
  it("prepare() clears the unfed/stale tracking (mirrors reset())", () => {
    // Public-field unit check: the stale bookkeeping survived prepare(),
    // so a re-prepare at a new rate stayed in "report silence" mode and
    // re-armed from a stale counter.
    const meter = new LufsMeter();
    meter.prepare(SR, BLOCK);
    meter.noteUnfed(SR * 3); // one full short-term window without a feed
    // TS-private fields — read through a lens (public behavior is asserted
    // via getShortTermLufs() reporting the silence floor).
    const state = () =>
      meter as unknown as {
        staleUntilTurnover: boolean;
        unfedSamples: number;
        fedSinceStale: number;
      };
    expect(state().staleUntilTurnover).toBe(true);
    expect(state().unfedSamples).toBeGreaterThanOrEqual(SR * 3);

    meter.prepare(44100, BLOCK); // re-prepare (e.g. sample-rate change)
    expect(state().staleUntilTurnover).toBe(false);
    expect(state().unfedSamples).toBe(0);
    expect(state().fedSinceStale).toBe(0);
  });

  it("bypassed time arms the LUFS stale guard while metering is gated off", () => {
    const proc = new UltinaProcessor();
    registerCoreModules(proc);
    proc.prepare({ sampleRate: SR, channelCount: 2, maxBlockSize: BLOCK, qualityMode: 1 });
    proc.setMetersEnabled(false);
    proc.setParameter("global.gainMatchEnabled", 1);
    const loudBlock = (b: number): Float32Array[] => {
      const chans = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let i = 0; i < BLOCK; i++) {
        const v = 0.5 * Math.sin((2 * Math.PI * 1000 * (b * BLOCK + i)) / SR);
        chans[0][i] = v;
        chans[1][i] = v;
      }
      return chans;
    };
    for (let b = 0; b < Math.ceil(4 * SR) / BLOCK; b++) proc.process(loudBlock(b), BLOCK);
    const loudLufs = proc.getLufsReading().shortTermLufs;
    expect(loudLufs).toBeGreaterThan(-30);

    // Bypass + silence for longer than the 3 s short-term window. Pre-fix
    // the meter never learned about this time: after unbypass, auto-gain
    // integrated against the PRE-bypass loudness for a full window.
    proc.setParameter("global.bypass", 1);
    const silence = (): Float32Array[] => [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let b = 0; b < Math.ceil(4 * SR) / BLOCK; b++) proc.process(silence(), BLOCK);
    expect(proc.getLufsReading().shortTermLufs).toBeLessThan(-50);
  });
});

describe("ultina hardening #3 — phase sidechain correlation window", () => {
  it("multi-chunk blocks correlate identically to single-chunk blocks", () => {
    // Differential test: processor A receives 1024-frame calls (chunked
    // internally into two 512-frame passes); processor B receives the SAME
    // signal as two 512-frame calls per iteration. Pre-fix, A's second
    // chunk correlated the dry window against the sidechain's FIRST window
    // (the chunk offset was ignored), so its auto-align trajectory diverged
    // from B's. Post-fix, both must follow the identical trajectory.
    const mk = () => {
      const mod = new PhaseModuleProcessor();
      mod.prepare({ sampleRate: SR, maxBlockSize: 512, channelCount: 2, qualityMode: 1 });
      return mod;
    };
    const multi = mk();
    const single = mk();
    const params = moduleParams({
      "phase.enabled": 1,
      "phase.sidechainEnabled": 1,
      "phase.autoAlignActive": 1,
      "phase.mix": 100,
    });
    const ctx512: ModuleProcessorContext = {
      sampleRate: SR,
      maxBlockSize: 512,
      channelCount: 2,
      qualityMode: 1,
    };

    const DELAY = 250; // samples of sidechain delay ≈ 5.21 ms
    const HALF = 512;
    let seed = 0x51e3d >>> 0;
    const noise = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296) * 2 - 1;
    };
    // Ring of past noise so the sidechain is a true delayed copy.
    const history = new Float32Array(HALF * 2 * 80 + HALF);
    for (let i = 0; i < history.length; i++) history[i] = noise();

    const halfBlocks = (base: number): { main: Float32Array[]; side: Float32Array[] } => {
      const main = [new Float32Array(HALF), new Float32Array(HALF)];
      const side = [new Float32Array(HALF), new Float32Array(HALF)];
      for (let i = 0; i < HALF; i++) {
        const abs = base + i;
        main[0][i] = history[abs];
        main[1][i] = history[abs];
        side[0][i] = history[abs - DELAY];
        side[1][i] = history[abs - DELAY];
      }
      return { main, side };
    };
    // Full-size block for the multi-chunk processor (2×HALF frames).
    const fullBlocks = (base: number): { main: Float32Array[]; side: Float32Array[] } => {
      const main = [new Float32Array(2 * HALF), new Float32Array(2 * HALF)];
      const side = [new Float32Array(2 * HALF), new Float32Array(2 * HALF)];
      for (let i = 0; i < 2 * HALF; i++) {
        const abs = base + i;
        main[0][i] = history[abs];
        main[1][i] = history[abs];
        side[0][i] = history[abs - DELAY];
        side[1][i] = history[abs - DELAY];
      }
      return { main, side };
    };

    const offsetOf = (m: PhaseModuleProcessor): number =>
      (m.getMeters() as { detectedOffsetMs: number }).detectedOffsetMs;

    for (let it = 0; it < 80; it++) {
      const a = fullBlocks(it * 2 * HALF);
      multi.process({ channels: a.main, frameCount: 2 * HALF, sidechain: a.side, ctx: ctx512, params });

      const b1 = halfBlocks(it * 2 * HALF);
      single.process({ channels: b1.main, frameCount: HALF, sidechain: b1.side, ctx: ctx512, params });
      const b2 = halfBlocks(it * 2 * HALF + HALF);
      single.process({ channels: b2.main, frameCount: HALF, sidechain: b2.side, ctx: ctx512, params });

      // Same data, same chunk schedule → identical trajectories. This is
      // the contract of the chunk-offset-aware sidechain indexing: the
      // auto-align measurement must not depend on how the host splits the
      // block. Pre-fix, the multi-chunk run diverged from the single-chunk
      // run at its very first cross-correlation fire.
      expect(offsetOf(multi)).toBeCloseTo(offsetOf(single), 9);
    }
    // Both hold a sane, in-range estimate (the time-decimated search is a
    // heuristic; its absolute accuracy is not this test's contract).
    const finalMulti = offsetOf(multi);
    expect(Number.isFinite(finalMulti)).toBe(true);
    expect(Math.abs(finalMulti)).toBeLessThan(60);
  });
});
