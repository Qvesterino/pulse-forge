import { describe, expect, it } from "vitest";

/**
 * Ozvena IR spectra pipeline — the off-thread convolution-load path.
 *
 * The partitioned convolver's load-time work (one forward FFT per IR
 * partition + the big Float64 allocations) used to run inside the worklet
 * port handler, i.e. ON THE AUDIO THREAD: a 2–8 ms stall on the first
 * selection of every (IR, sample rate) — the dropout users read as "this
 * tool crashes sound". The spectra are now precomputed OFF-thread
 * (precomputeConvolverSpectra) and shipped to the engine as transferables
 * (createPartitionedConvolverFromPrecomputed / engine.loadIrPrecomputed).
 *
 * The one invariant everything here protects: the precomputed path is
 * STRUCTURALLY IDENTICAL to the time-domain path — same rings, same FFT
 * schedule, same latency, BIT-IDENTICAL output.
 */
import {
  createPartitionedConvolver,
  createPartitionedConvolverFromPrecomputed,
  numPartitionsFor,
  partitionSizeForIr,
  precomputeConvolverSpectra,
  validatePrecomputedIrSet,
  type PrecomputedIrSet,
} from "../src/effects/ozvena-core/dsp/fftPartitioned.js";
import { createConvolutionEngine } from "../src/effects/ozvena-core/engines/convolutionEngine.js";

const SR = 48000;

function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Deterministic decaying noise IR (normalized so convolver output stays bounded). */
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

function renderConvolver(
  conv: ReturnType<typeof createPartitionedConvolver>,
  seconds: number,
  blockSize: number,
): Float32Array {
  const blocks = Math.ceil((seconds * SR) / blockSize);
  const out = new Float32Array(blocks * blockSize);
  const rng = makeRng(0xC0FFEE);
  for (let b = 0; b < blocks; b++) {
    const input = new Float32Array(blockSize);
    for (let i = 0; i < blockSize; i++) input[i] = (rng() * 2 - 1) * 0.5;
    conv.process(input, blockSize, out.subarray(b * blockSize, (b + 1) * blockSize));
  }
  return out;
}

describe("partitioned convolver — precomputed spectra parity", () => {
  const FRAMES = 5000; // spans multiple partitions
  const td = makeIr(FRAMES);

  it.each([128, 333, 1024])(
    "precomputed convolver output is bit-identical to the time-domain convolver (block=%i)",
    (blockSize) => {
      const pre = precomputeConvolverSpectra(td);
      const fromTd = createPartitionedConvolver(td, {
        irLength: FRAMES,
        partitionSize: partitionSizeForIr(FRAMES),
      });
      const fromPre = createPartitionedConvolverFromPrecomputed(pre);

      expect(fromPre.partitionSize).toBe(fromTd.partitionSize);
      expect(fromPre.numPartitions).toBe(fromTd.numPartitions);
      expect(fromPre.latency).toBe(fromTd.latency);

      const a = renderConvolver(fromTd, 0.3, blockSize);
      const b = renderConvolver(fromPre, 0.3, blockSize);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
    },
  );

  it("precomputed convolver reset() restores bit-identical behavior", () => {
    const pre = precomputeConvolverSpectra(td);
    const conv = createPartitionedConvolverFromPrecomputed(pre);
    const first = renderConvolver(conv, 0.15, 128);
    conv.reset();
    const second = renderConvolver(conv, 0.15, 128);
    for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
  });

  it("a cached set reused WITHOUT blockSpectra still renders identically", () => {
    // The worklet cache hands a set's zeroed blockSpectra to the first
    // consumer and leaves later consumers without it (two instances must
    // never share one MUTABLE ring). The engine-allocated ring is
    // write-before-read, so the output must be identical either way.
    const pre = precomputeConvolverSpectra(td);
    const a = renderConvolver(createPartitionedConvolverFromPrecomputed(pre), 0.15, 128);
    const stripped: PrecomputedIrSet = { ...pre };
    delete (stripped as { blockSpectra?: Float64Array }).blockSpectra;
    const b = renderConvolver(createPartitionedConvolverFromPrecomputed(stripped), 0.15, 128);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });

  it("validatePrecomputedIrSet rejects corrupt payloads", () => {
    const pre = precomputeConvolverSpectra(makeIr(3000));
    const good = validatePrecomputedIrSet(pre);
    expect(good).not.toBeNull();

    expect(validatePrecomputedIrSet(null)).toBeNull();
    expect(validatePrecomputedIrSet({})).toBeNull();
    expect(
      validatePrecomputedIrSet({
        ...pre,
        irSpectra: new Float64Array(pre.irSpectra.length - 2), // truncated
      }),
    ).toBeNull();
    expect(
      validatePrecomputedIrSet({ ...pre, numPartitions: pre.numPartitions + 1 }), // inconsistent
    ).toBeNull();
    expect(
      validatePrecomputedIrSet({ ...pre, partitionSize: 2040 }), // not a power of two
    ).toBeNull();
    expect(validatePrecomputedIrSet({ ...pre, irLengthSamples: 0 })).toBeNull();
  });

  it("partition sizing helpers match the engine's historical formula", () => {
    expect(partitionSizeForIr(1000)).toBe(2048); // min floor
    expect(partitionSizeForIr(144000)).toBe(2048); // 3 s @ 48k
    expect(numPartitionsFor(144000, 2048)).toBe(Math.ceil(144000 / 1024));
    expect(numPartitionsFor(1, 2048)).toBe(1);
  });
});

describe("convolution engine — loadIrPrecomputed parity", () => {
  /** Interleave mono channels into an engine-shaped IR payload. */
  function interleave(chans: Float32Array[]): { data: Float32Array; channels: 1 | 2 | 4 } {
    const channels = (chans.length >= 4 ? 4 : chans.length >= 2 ? 2 : 1) as 1 | 2 | 4;
    const frames = chans[0].length;
    const data = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
      for (let i = 0; i < frames; i++) data[i * channels + c] = chans[c][i];
    }
    return { data, channels };
  }

  /** Precomputed sets for a stereo-bus engine, matching the node's layout. */
  function precomputedSets(
    chans: Float32Array[],
  ): { sets: PrecomputedIrSet[]; channels: 1 | 2 | 4 } {
    const channels = (chans.length >= 4 ? 4 : chans.length >= 2 ? 2 : 1) as 1 | 2 | 4;
    const frames = chans[0].length;
    const ps = partitionSizeForIr(frames);
    const np = numPartitionsFor(frames, ps);
    const spectra = chans.map((ch) =>
      precomputeConvolverSpectra(ch, { partitionSize: ps, irLengthSamples: frames }).irSpectra,
    );
    const slots = channels === 1 ? 2 : channels;
    const sets: PrecomputedIrSet[] = [];
    for (let slot = 0; slot < slots; slot++) {
      sets.push({
        irSpectra: spectra[Math.min(slot, spectra.length - 1)],
        blockSpectra: new Float64Array(np * ps * 2),
        numPartitions: np,
        partitionSize: ps,
        irLengthSamples: frames,
      });
    }
    return { sets, channels };
  }

  function renderEngine(
    engine: ReturnType<typeof createConvolutionEngine>,
    seconds: number,
  ): Float32Array[] {
    const blocks = Math.ceil((seconds * SR) / 128);
    const out = [
      new Float32Array(blocks * 128),
      new Float32Array(blocks * 128),
    ];
    const rng = makeRng(0xBEEF);
    for (let b = 0; b < blocks; b++) {
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        l[i] = (rng() * 2 - 1) * 0.5;
        r[i] = (rng() * 2 - 1) * 0.5;
      }
      engine.process([l, r], 128);
      out[0].set(l, b * 128);
      out[1].set(r, b * 128);
    }
    return out;
  }

  const FRAMES = 5000;
  const L = makeIr(FRAMES, 11);
  const R = makeIr(FRAMES, 22);

  it.each([
    ["stereo IR", [L, R], 2 as const],
    ["mono IR broadcast", [L], 1 as const],
  ])("%s: precomputed load output is bit-identical to loadIr", (_name, chans, irCh) => {
    const a = createConvolutionEngine();
    a.prepare(SR, 2, 2048);
    const { data } = interleave(chans);
    a.loadIr(data, SR, irCh);

    const b = createConvolutionEngine();
    b.prepare(SR, 2, 2048);
    const { sets, channels } = precomputedSets(chans);
    b.loadIrPrecomputed(sets, channels);

    expect(b.isIrLoaded()).toBe(true);
    expect(b.getLatencySamples()).toBe(a.getLatencySamples());
    expect(b.getIrChannels()).toBe(a.getIrChannels());
    expect(b.getIrLengthSamples()).toBe(a.getIrLengthSamples());

    const outA = renderEngine(a, 0.3);
    const outB = renderEngine(b, 0.3);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < outA[c].length; i++) expect(outB[c][i]).toBe(outA[c][i]);
    }
  });

  it("true-stereo quad IR: precomputed load output is bit-identical to loadIr", () => {
    const LL = makeIr(FRAMES, 31);
    const LR = makeIr(FRAMES, 32);
    const RL = makeIr(FRAMES, 33);
    const RR = makeIr(FRAMES, 34);
    const chans = [LL, LR, RL, RR];

    const a = createConvolutionEngine();
    a.prepare(SR, 2, 2048);
    const { data } = interleave(chans);
    a.loadIr(data, SR, 4);

    const b = createConvolutionEngine();
    b.prepare(SR, 2, 2048);
    const { sets, channels } = precomputedSets(chans);
    expect(sets.length).toBe(4);
    b.loadIrPrecomputed(sets, channels);

    const outA = renderEngine(a, 0.25);
    const outB = renderEngine(b, 0.25);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < outA[c].length; i++) expect(outB[c][i]).toBe(outA[c][i]);
    }
  });

  it("mono bus engine consumes only the first set", () => {
    const a = createConvolutionEngine();
    a.prepare(SR, 1, 2048);
    const { data } = interleave([L, R]);
    a.loadIr(data, SR, 2);

    const b = createConvolutionEngine();
    b.prepare(SR, 1, 2048);
    const { sets } = precomputedSets([L, R]); // node ships stereo-bus sets
    b.loadIrPrecomputed(sets, 2);

    expect(b.isIrLoaded()).toBe(true);
    // A mono bus reports the mono-broadcast convention, exactly like loadIr.
    expect(b.getIrChannels()).toBe(a.getIrChannels());
    expect(b.getLatencySamples()).toBe(a.getLatencySamples());

    const blocks = 40;
    const rng = makeRng(0xFEED);
    for (let blk = 0; blk < blocks; blk++) {
      const inA = new Float32Array(128);
      const inB = new Float32Array(128);
      const outA = new Float32Array(128);
      const outB = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        inA[i] = (rng() * 2 - 1) * 0.5;
        inB[i] = inA[i];
      }
      a.process([inA], 128);
      b.process([inB], 128);
      // a.process wrote into inA via computeWetSet; b into inB — compare.
      for (let i = 0; i < 128; i++) expect(inB[i]).toBe(inA[i]);
      void outA;
      void outB;
    }
  });

  it("a corrupt sets payload clears the IR instead of arming garbage", () => {
    const engine = createConvolutionEngine();
    engine.prepare(SR, 2, 2048);
    const { sets } = precomputedSets([L, R]);
    const broken = sets.map((s) => ({
      ...s,
      irSpectra: s.irSpectra.subarray(0, s.irSpectra.length - 8),
    }));
    engine.loadIrPrecomputed(broken, 2);
    expect(engine.isIrLoaded()).toBe(false);

    // A good payload after a bad one still loads.
    const { sets: good } = precomputedSets([L, R]);
    engine.loadIrPrecomputed(good, 2);
    expect(engine.isIrLoaded()).toBe(true);
  });

  it("an IR swap mid-render still crossfades on the precomputed path (finite, bounded)", () => {
    const engine = createConvolutionEngine();
    engine.prepare(SR, 2, 2048);
    const first = precomputedSets([makeIr(FRAMES, 41), makeIr(FRAMES, 42)]);
    engine.loadIrPrecomputed(first.sets, 2);

    const rng = makeRng(0xA11CE);
    let nonFinite = 0;
    let maxAbs = 0;
    for (let b = 0; b < 300; b++) {
      if (b === 100) {
        const second = precomputedSets([makeIr(FRAMES, 51), makeIr(FRAMES, 52)]);
        engine.loadIrPrecomputed(second.sets, 2);
      }
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        l[i] = (rng() * 2 - 1) * 0.5;
        r[i] = (rng() * 2 - 1) * 0.5;
      }
      engine.process([l, r], 128);
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) nonFinite++;
        maxAbs = Math.max(maxAbs, Math.abs(l[i]), Math.abs(r[i]));
      }
    }
    expect(nonFinite).toBe(0);
    expect(maxAbs).toBeLessThanOrEqual(1.2);
  });
});
