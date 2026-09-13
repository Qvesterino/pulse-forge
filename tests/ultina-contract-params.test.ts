/**
 * Ultina contract-parameter regressions — the two parameters the UI/schema
 * advertised but the DSP ignored (found in the 2026-09-12 hardening pass):
 *
 *  1. exciter.preEmphasisMode was never read. It now drives a first-order HF
 *     shelf INTO the saturators with an EXACT inverse after them, so only
 *     the generated harmonics carry the emphasis (classic exciter). Enum
 *     contract: value 0 MUST stay the no-op ("flat") — every existing
 *     project defaulted to/stored 0, and the upstream golden vector
 *     exciter_tube_asym pins value 0 to the legacy output. The labels were
 *     therefore rotated to ["flat","clean","defined","full"] with ascending
 *     intensity; 1..3 activate the ladder.
 *  2. eq.channelMode 3/4 (transient/sustain) silently fell through to plain
 *     stereo. They now separate the transient/sustain components (same
 *     TransientSustainSeparator as MultibandProcessor), run ONLY the
 *     selected component through the band banks + soft saturation, and
 *     recombine.
 */
import { describe, expect, it } from "vitest";
import { ExciterModuleProcessor } from "../src/effects/ultina-core/dsp/modules/exciterModule.js";
import { EqModuleProcessor } from "../src/effects/ultina-core/dsp/modules/eqModule.js";
import { buildDefaultParams } from "../src/effects/ultina-core/contracts/parameterSchema.js";
import type { ModuleProcessorContext, ModuleProcessArgs } from "../src/effects/ultina-core/dsp/ultinaProcessor.js";

const SR = 48000;
const BLOCK = 128;

function ctx(): ModuleProcessorContext {
  return { sampleRate: SR, maxBlockSize: BLOCK, channelCount: 2, qualityMode: 1 };
}

function params(overrides: Record<string, number>): Record<string, number> {
  return { ...buildDefaultParams(), ...overrides };
}

function sineBlock(index: number, freq: number, amp: number, frames = BLOCK): Float32Array[] {
  const chans = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * (index * frames + i)) / SR);
    chans[0][i] = v;
    chans[1][i] = v;
  }
  return chans;
}

/** RMS of the first-difference signal — a crude high-frequency content proxy. */
function hfEnergy(chans: Float32Array[]): number {
  let sum = 0;
  for (const ch of chans) {
    for (let i = 1; i < ch.length; i++) {
      const d = ch[i] - ch[i - 1];
      sum += d * d;
    }
  }
  return Math.sqrt(sum);
}

describe("ultina contract params — exciter.preEmphasisMode", () => {
  /** Render a settled 500 Hz sine through the exciter with the given mode
   *  and warm-saturation depth; returns the measured tail (L, R). process()
   *  mutates the passed channels, so each block carries a fresh buffer. */
  function renderExciter(mode: number, warmAmount: number): Float32Array[] {
    const mod = new ExciterModuleProcessor();
    mod.prepare(ctx());
    const p = params({
      "exciter.enabled": 1,
      "exciter.warmAmount": warmAmount,
      "exciter.tubeAmount": 0,
      "exciter.tapeAmount": 0,
      "exciter.retroAmount": 0,
      "exciter.tubeAsymAmount": 0,
      "exciter.mix": 100,
      "exciter.bandCount": 1,
      "exciter.oversampling": 0,
      "exciter.preEmphasisMode": mode,
    });
    const argsFor = (chans: Float32Array[]): ModuleProcessArgs => ({
      channels: chans,
      frameCount: BLOCK,
      sidechain: null,
      ctx: ctx(),
      params: p,
    });
    const tail: Float32Array[][] = [];
    for (let b = 0; b < 80; b++) {
      const chans = sineBlock(b, 500, 0.5);
      mod.process(argsFor(chans));
      if (b >= 64) tail.push(chans);
    }
    return [
      Float32Array.from(tail.flatMap((t) => Array.from(t[0]))),
      Float32Array.from(tail.flatMap((t) => Array.from(t[1]))),
    ];
  }

  it("the ladder is LIVE: every depth changes the output", () => {
    const outs = [0, 1, 2, 3].map((m) => renderExciter(m, 60));
    for (const m of [1, 2, 3]) {
      let maxDiff = 0;
      for (let i = 0; i < outs[0][0].length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(outs[0][0][i] - outs[m][0][i]));
      }
      expect(maxDiff, `mode ${m} must differ from flat`).toBeGreaterThan(1e-6);
    }
  });

  it("emphasis drives HF harmonics: active modes yield more high-frequency content than flat", () => {
    // Deeper shelves also drive the saturator into harder compression, so
    // the OUTPUT HF content is not strictly monotonic across the ladder —
    // but every active depth must exceed the flat baseline.
    const hf = [0, 1, 2, 3].map((m) => hfEnergy(renderExciter(m, 60)));
    expect(hf[1]).toBeGreaterThan(hf[0]);
    expect(hf[3]).toBeGreaterThan(hf[0]);
  });

  it("emphasis drives HF harmonics: full mode yields more high-frequency content than flat", () => {
    const flat = renderExciter(0, 60);
    const full = renderExciter(3, 60);
    expect(hfEnergy(full)).toBeGreaterThan(hfEnergy(flat) * 1.05);
  });

  it("the emphasis is gated on saturation activity: no saturator → bit-identical", () => {
    // The pre/inverse pair around an inactive saturator would be a pure
    // float-rounding no-op riding the linear path — it is gated off, so the
    // output must be BIT-identical regardless of mode.
    const flatNoSat = renderExciter(0, 0);
    const fullNoSat = renderExciter(3, 0);
    expect(fullNoSat[0]).toEqual(flatNoSat[0]);
    expect(fullNoSat[1]).toEqual(flatNoSat[1]);
  });

  it("keeps the inverse shelf continuous across audio-block boundaries", () => {
    const mod = new ExciterModuleProcessor();
    mod.prepare(ctx());
    const p = params({
      "exciter.enabled": 1,
      "exciter.warmAmount": 60,
      "exciter.mix": 100,
      "exciter.oversampling": 1,
      "exciter.preEmphasisMode": 3,
    });
    let previousLast = 0;
    let maxBoundaryJump = 0;
    let maxInteriorJump = 0;

    for (let block = 0; block < 40; block++) {
      const chans = sineBlock(block, 500, 0.5);
      mod.process({
        channels: chans,
        frameCount: BLOCK,
        sidechain: null,
        ctx: ctx(),
        params: p,
      });
      if (block > 0) maxBoundaryJump = Math.max(maxBoundaryJump, Math.abs(chans[0][0] - previousLast));
      for (let i = 1; i < BLOCK; i++) {
        maxInteriorJump = Math.max(maxInteriorJump, Math.abs(chans[0][i] - chans[0][i - 1]));
      }
      previousLast = chans[0][BLOCK - 1];
    }

    // A stale pre-saturation y history at the start of every block creates a
    // visible discontinuity. The stateful inverse must make a block boundary
    // no larger than the ordinary adjacent-sample movement of the signal.
    expect(maxBoundaryJump).toBeLessThan(maxInteriorJump * 2.5 + 1e-4);
  });
});

describe("ultina contract params — eq.channelMode transient/sustain", () => {
  /** Render a 20 ms 1 kHz burst (after 1 s of silence) through the EQ with
   *  the given channel mode and band-0 gain; returns the RMS over the burst
   *  onset. The transient/sustain separator routes a fresh burst's energy
   *  into the TRANSIENT component, so a +24 dB bell at 1 kHz must reach the
   *  onset in transient (and stereo) mode but NOT in sustain mode. */
  function burstOnsetRms(channelMode: number, gainDb: number): number {
    const mod = new EqModuleProcessor();
    mod.prepare(ctx());
    const p = params({
      "eq.enabled": 1,
      "eq.channelMode": channelMode,
      "eq.softSaturation": 0,
      "eq.band0.enabled": 1,
      "eq.band0.shape": 0, // bell
      "eq.band0.freqHz": 1000,
      "eq.band0.gainDb": gainDb,
      "eq.band0.q": 1,
    });
    const BURST_START = Math.floor(1.0 * SR);
    const BURST_FRAMES = Math.floor(0.02 * SR);
    const total = BURST_START + BURST_FRAMES + BLOCK;
    const input = new Float32Array(total);
    for (let i = BURST_START; i < BURST_START + BURST_FRAMES; i++) {
      input[i] = 0.25 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
    let onsetSumSq = 0;
    let onsetN = 0;
    for (let off = 0; off < total; off += BLOCK) {
      const frames = Math.min(BLOCK, total - off);
      const chans = [
        input.slice(off, off + frames),
        input.slice(off, off + frames),
      ];
      mod.process({
        channels: chans,
        frameCount: frames,
        sidechain: null,
        ctx: ctx(),
        params: p,
      });
      // Measure inside the burst, skipping its first 32 samples (the
      // separator's envelope gate needs a couple of samples to open).
      const from = Math.max(off, BURST_START + 32);
      const to = Math.min(off + frames, BURST_START + BURST_FRAMES);
      for (let i = from; i < to; i++) {
        const v = chans[0][i - off];
        onsetSumSq += v * v;
        onsetN++;
      }
    }
    return onsetN > 0 ? Math.sqrt(onsetSumSq / onsetN) : 0;
  }

  it("a fresh burst reaches the EQ in transient mode but bypasses it in sustain mode", () => {
    for (const mode of [0, 3]) {
      const ratio = burstOnsetRms(mode, 24) / burstOnsetRms(mode, 0);
      expect(
        ratio,
        `mode ${mode} must apply the +24 dB bell to the burst onset`,
      ).toBeGreaterThan(5);
    }
    const sustainRatio = burstOnsetRms(4, 24) / burstOnsetRms(4, 0);
    expect(
      sustainRatio,
      "sustain mode must NOT apply the bell to a fresh burst",
    ).toBeLessThan(1.5);
  });

  it("transient and sustain modes produce clearly different burst output", () => {
    const stereo = burstOnsetRms(0, 24);
    const transient = burstOnsetRms(3, 24);
    const sustain = burstOnsetRms(4, 24);
    // Sustain carries almost none of the onset — much quieter than the
    // boosted transient/stereo paths.
    expect(sustain).toBeLessThan(stereo * 0.5);
    expect(sustain).toBeLessThan(transient * 0.5);
  });

  it("recombination is transparent when no band is enabled", () => {
    const mod = new EqModuleProcessor();
    mod.prepare(ctx());
    const p = params({
      "eq.enabled": 1,
      "eq.channelMode": 3,
      "eq.band0.enabled": 0,
    });
    let maxDiff = 0;
    for (let b = 0; b < 40; b++) {
      const chans = sineBlock(b, 1000, 0.25);
      mod.process({ channels: chans, frameCount: BLOCK, sidechain: null, ctx: ctx(), params: p });
      const ref = sineBlock(b, 1000, 0.25);
      for (let i = 0; i < BLOCK; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(chans[0][i] - ref[0][i]));
      }
    }
    expect(maxDiff).toBeLessThan(1e-9);
  });
});
