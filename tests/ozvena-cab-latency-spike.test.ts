import { describe, expect, it } from "vitest";

/**
 * SPIKE — CAB input-insert latency. Phase 2 of
 * docs/IMPLEMENTATION-ROADMAP-INPUT-FX-CAB.md.
 *
 * The question this file exists to answer, in one sentence: **can the existing
 * DRIFT convolution core run a cabinet IR at a latency a guitarist can play
 * against, or is the 2048 floor the blocker?**
 *
 * Everything asserted here was measured, not assumed:
 *   - `createConvolutionEngine(partitionSize = 2048)` is how ozvenaProcessor.ts
 *     builds the live engine (no argument passed), and `loadIr` takes
 *     `Math.max(partitionSize, recommendPartitionSize(irLength))`, so the
 *     configured value is a floor that is never lowered.
 *   - Latency is `partitionSize / 2` (convolutionEngine.ts getLatencySamples).
 *
 * The assertion that matters most is the last one: partitioned FFT convolution
 * is linear time-invariant, so a different partition size must change WHEN
 * samples come out, not WHAT comes out. If that test ever fails, the "just
 * lower the floor" plan in the roadmap is dead and the CAB needs its own
 * engine rather than a DRIFT configuration change.
 */
import { createConvolutionEngine } from "../src/effects/ozvena-core/engines/convolutionEngine.js";
import { createPartitionedConvolver, recommendPartitionSize } from "../src/effects/ozvena-core/dsp/fftPartitioned.js";

const SR = 48000;
const BLOCK = 256;
/** Typical cabinet IR: long enough to matter, short enough to be musical. */
const CAB_SECONDS = 0.03;
const CAB_FRAMES = Math.round(SR * CAB_SECONDS);

function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Deterministic decaying-noise IR, L1-normalised so the output stays bounded. */
function makeIr(frames: number, seed = 7): Float32Array {
  const rng = makeRng(seed);
  const ir = new Float32Array(frames);
  let l1 = 0;
  for (let i = 0; i < frames; i++) {
    const v = (rng() * 2 - 1) * Math.exp(-i / (frames / 6));
    ir[i] = v;
    l1 += Math.abs(v);
  }
  const inv = 1 / l1;
  for (let i = 0; i < frames; i++) ir[i] *= inv;
  return ir;
}

/** Render `seconds` of deterministic white noise through a convolver. */
function render(partitionSize: number, seconds: number): Float32Array {
  const ir = makeIr(CAB_FRAMES);
  const conv = createPartitionedConvolver(ir, { irLength: CAB_FRAMES, partitionSize });
  const blocks = Math.ceil((seconds * SR) / BLOCK);
  const out = new Float32Array(blocks * BLOCK);
  const rng = makeRng(0xc0ffee);
  for (let b = 0; b < blocks; b++) {
    const input = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) input[i] = (rng() * 2 - 1) * 0.5;
    conv.process(input, BLOCK, out.subarray(b * BLOCK, (b + 1) * BLOCK));
  }
  return out;
}

describe("CAB latency spike — the 2048 floor", () => {
  it("recommendPartitionSize would pick 128 for a 30 ms cab IR", () => {
    expect(recommendPartitionSize(CAB_FRAMES)).toBe(128);
    expect(recommendPartitionSize(CAB_FRAMES) / 2 / SR).toBeCloseTo(0.00133, 5);
  });

  it("the engine as built today is pinned at 2048 → 21.33 ms, whatever the IR length", () => {
    const engine = createConvolutionEngine();
    engine.prepare(SR, 1, BLOCK);
    engine.loadIr(makeIr(CAB_FRAMES), SR, 1);

    expect(engine.isIrLoaded()).toBe(true);
    expect(engine.getLatencySamples()).toBe(1024);
    expect((engine.getLatencySamples() / SR) * 1000).toBeCloseTo(21.33, 2);
  });

  it("latency is identical for a 10 ms and a 1 s IR — the floor hides IR length", () => {
    const short = createConvolutionEngine();
    short.prepare(SR, 1, BLOCK);
    short.loadIr(makeIr(SR * 0.01), SR, 1);

    const long = createConvolutionEngine();
    long.prepare(SR, 1, BLOCK);
    long.loadIr(makeIr(SR * 1.0), SR, 1);

    expect(short.getLatencySamples()).toBe(long.getLatencySamples());
    expect(short.getLatencySamples()).toBe(1024);
  });

  it("a low floor does lower the partition and the latency", () => {
    const engine = createConvolutionEngine(64);
    engine.prepare(SR, 1, BLOCK);
    engine.loadIr(makeIr(CAB_FRAMES), SR, 1);

    expect(engine.getLatencySamples()).toBe(64);
    expect((engine.getLatencySamples() / SR) * 1000).toBeCloseTo(1.33, 2);
  });

  it("the low floor still escalates for long IRs instead of degrading them", () => {
    const engine = createConvolutionEngine(64);
    engine.prepare(SR, 1, BLOCK);
    engine.loadIr(makeIr(SR * 1.0), SR, 1);

    // recommendPartitionSize(48000) = nextPow2(2*sqrt(48000)) = 512 → 256 samples.
    expect(engine.getLatencySamples()).toBe(256);
  });
});

describe("CAB latency spike — does the partition change the sound?", () => {
  /**
   * The two partition sizes carry different latency (1024 vs 64 samples), so
   * a naive sample-for-sample comparison measures that offset, not fidelity.
   * Find the lag that best aligns them and compare there — that separates
   * "same convolution, shifted in time" from "different convolution".
   */
  function bestLag(a: Float32Array, b: Float32Array, maxLag: number): { lag: number; residual: number } {
    const skip = SR * 0.1;
    let best = { lag: 0, residual: Number.POSITIVE_INFINITY };
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = skip; i < a.length - maxLag; i++) sum += Math.abs(a[i] - b[i - lag]);
      if (sum < best.residual) best = { lag, residual: sum };
    }
    return best;
  }

  it("partition size changes WHEN samples arrive, not WHAT they are", () => {
    const coarse = render(2048, 0.25);
    const fine = render(128, 0.25);

    const skip = SR * 0.1;
    let peak = 0;
    for (let i = skip; i < coarse.length; i++) peak = Math.max(peak, Math.abs(coarse[i]));
    expect(peak).toBeGreaterThan(0);

    // Documented offset: getLatencySamples() is partitionSize / 2.
    const { lag, residual } = bestLag(coarse, fine, 1200);
    const meanResidual = residual / (coarse.length - skip - 1200);

    // Printed rather than only asserted: the measured offset is evidence for
    // the roadmap, and a silent pass would hide it.
    console.log(
      `[cab-spike] best lag=${lag} samples (${((lag / SR) * 1000).toFixed(3)} ms), ` +
        `mean residual=${meanResidual.toExponential(3)}, peak=${peak.toExponential(3)}`,
    );

    expect(lag).toBeGreaterThan(0);
    expect(meanResidual).toBeLessThan(peak * 1e-3);
  });

  it("neither partition produces non-finite samples", () => {
    for (const ps of [128, 512, 2048]) {
      const out = render(ps, 0.2);
      expect(out.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});

describe("CAB latency spike — CPU cost", () => {
  /**
   * Reports rather than asserts. A wall-clock budget here would be flaky on
   * shared CI, and the number that matters is the RATIO between partitions —
   * it is machine-independent, and it is what tells us whether a small
   * partition floor is affordable at all.
   */
  it("realtime factor per partition size (report, no budget)", () => {
    const AUDIO_SECONDS = 0.5;

    const measure = (partitionSize: number): number => {
      const t0 = performance.now();
      render(partitionSize, AUDIO_SECONDS);
      return (performance.now() - t0) / (AUDIO_SECONDS * 1000);
    };

    measure(2048);
    measure(128);

    const best = (partitionSize: number) => Math.min(measure(partitionSize), measure(partitionSize));

    const factor2048 = best(2048);
    const factor128 = best(128);
    const factor64 = best(64);

    console.log(
      `[cab-spike] realtime factor — 2048: ${factor2048.toFixed(3)}x, ` +
        `128: ${factor128.toFixed(3)}x, 64: ${factor64.toFixed(3)}x ` +
        `(ratio 128 vs 2048: ${(factor128 / factor2048).toFixed(2)}x)`,
    );

    // A convolution costing more than real time cannot run in an AudioWorklet.
    expect(factor128).toBeLessThan(1);
  });
});
