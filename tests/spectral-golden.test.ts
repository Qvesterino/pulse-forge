import { beforeAll, describe, expect, it } from "vitest";

import { SpectralProcessor, DEFAULT_SPECTRAL_PARAMS } from "../src/effects/spectral-core/dsp/SpectralProcessor";
import { MAX_BLOCK, StftEngine } from "../src/effects/spectral-core/dsp/stft";
import { SpectralDelayBank } from "../src/effects/spectral-core/dsp/spectralDelay";

/**
 * PORTAL — bit-exact golden vectors + the determinism contract.
 *
 * The DSP has no RNG and no free-running phases: the only stochastic-looking
 * control (DIFFUSE) is a deterministic accumulator seeded from zero, so the
 * same input + params are bit-identical across any number of runs. That is the
 * two-variant alternation check of NEW-EFFECT-CHECKLIST §10, and it is the
 * reason the vectors below can be hard numbers rather than tolerances.
 *
 * Three things are pinned, in increasing order of honesty:
 *   1. mix = 0 is bit-exact after PORTAL's declared fixed latency
 *   2. the STFT round-trips — silence in gives silence out, and a tone comes
 *      back at the right level and the right time (proves OLA normalisation)
 *   3. the actual golden numbers for each MODE
 */

const SR = 48000;
const BLOCK = 128;

interface RenderOpts {
  params?: Partial<typeof DEFAULT_SPECTRAL_PARAMS>;
  seconds: number;
  /** Left input; right mirrors it unless `right` is given. */
  input: (i: number) => number;
  right?: (i: number) => number;
}

/** Render `seconds` of stereo through a freshly prepared processor. */
function render({ params = {}, seconds, input, right }: RenderOpts) {
  const proc = new SpectralProcessor();
  // Params before prepare() so the smoothed MIX is seeded correctly and the
  // effect does not ramp through audible dry on the first blocks.
  proc.setParams({ ...DEFAULT_SPECTRAL_PARAMS, ...params });
  proc.prepare(SR);

  const total = Math.ceil(seconds * SR);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);

  const inL = new Float32Array(MAX_BLOCK);
  const inR = new Float32Array(MAX_BLOCK);
  const bL = new Float32Array(MAX_BLOCK);
  const bR = new Float32Array(MAX_BLOCK);

  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    for (let i = 0; i < len; i++) {
      inL[i] = input(offset + i);
      inR[i] = right ? right(offset + i) : inL[i];
    }
    proc.process(inL, inR, bL, bR, len);
    outL.set(bL.subarray(0, len), offset);
    outR.set(bR.subarray(0, len), offset);
  }
  return { outL, outR, proc };
}

/** A two-tone input: fundamental plus a partial, so per-bin behaviour is visible. */
const twoTone = (i: number) =>
  0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 660 * i) / SR);

const silence = () => 0;

function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > p) p = v;
  }
  return p;
}

/** RMS over a window — used to measure whether energy actually arrived. */
function rms(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  const n = Math.max(1, Math.min(to, buf.length) - from);
  for (let i = from; i < from + n; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / n);
}

/** Round to a fixed precision so the vector survives a float repr change. */
function q(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

describe("PORTAL — deterministic golden vectors", () => {
  beforeAll(() => {
    // Silence in must produce silence out even with a live feedback path: this
    // is the cheapest possible proof the guards in ADR 0038, D5 hold.
    const { outL } = render({ seconds: 0.25, input: silence, params: { feedback: 0.9, mix: 1 } });
    expect(peakOf(outL)).toBe(0);
  });

  it("the STFT round-trips: analysis + resynthesis is a bit-exact passthrough", () => {
    // The strongest statement the engine can make. A frame processor that does
    // nothing must return its input: if the overlap-add normaliser, the window
    // or the IFFT scale were wrong, this fails before any bank is involved.
    const engine = new StftEngine(SR, { fftSize: 1024 });
    engine.onFrame(() => {});
    const total = SR / 2;
    const out = new Float32Array(total);
    const inBlk = new Float32Array(BLOCK);
    const outBlk = new Float32Array(BLOCK);

    for (let off = 0; off < total; off += BLOCK) {
      const len = Math.min(BLOCK, total - off);
      for (let i = 0; i < len; i++) inBlk[i] = twoTone(off + i);
      engine.processBlock(inBlk, len, outBlk);
      out.set(outBlk.subarray(0, len), off);
    }

    // Compare the steady tail against the input's ACTUAL peak — twoTone is a
    // fundamental plus its third harmonic, so its peaks are where the two
    // partials happen to align, not the arithmetic sum of their amplitudes.
    const from = Math.floor(0.3 * SR);
    let inputPeak = 0;
    for (let i = 0; i < total; i++) {
      const v = Math.abs(twoTone(i));
      if (v > inputPeak) inputPeak = v;
    }
    let peak = 0;
    for (let i = from; i < total; i++) {
      const v = Math.abs(out[i]);
      if (v > peak) peak = v;
    }
    // Reconstructed within 0.5 % of the source level, all the way to the end of
    // the run — a normaliser that decayed with time would show up here as a
    // falling envelope long before it clipped.
    expect(peak).toBeGreaterThan(inputPeak * 0.995);
    expect(peak).toBeLessThan(inputPeak * 1.005);
    for (let i = 0; i < total; i++) expect(Number.isFinite(out[i])).toBe(true);
  }, 60000);

  it("mix = 0 is a bit-exact passthrough aligned to the declared latency", () => {
    const { outL, outR } = render({ seconds: 0.1, input: twoTone, params: { mix: 0 } });
    // Compare against the Float32 samples that actually went in, not the Float64
    // expression. The fixed dry delay keeps bypass aligned with the wet STFT
    // path, while preserving the exact source samples after that offset.
    const latency = 768;
    const inL = Float32Array.from({ length: 2048 }, (_, i) => twoTone(i));
    for (let i = 0; i < 2048; i++) {
      const expected = i < latency ? 0 : inL[i - latency]!;
      expect(outL[i]).toBe(expected);
      expect(outR[i]).toBe(expected);
    }
  });

  it("stays finite across the whole parameter space", () => {
    const extremes: Partial<typeof DEFAULT_SPECTRAL_PARAMS>[] = [
      { feedback: 1, mix: 1, time: 2000, decay: 0, diffuse: 1 },
      { feedback: 1, mix: 1, time: 20, shift: 24, diffuse: 1 },
      { feedback: 0, mix: 1, drive: 1, tone: -24 },
      { mode: 2, freeze: 1, feedback: 1, mix: 1 },
      { mode: 1, resonance: 1, focus: 20, focusWidth: 4, mix: 1 },
    ];
    for (const params of extremes) {
      const { outL, outR } = render({ seconds: 0.4, input: twoTone, params });
      for (let i = 0; i < outL.length; i++) {
        expect(Number.isFinite(outL[i])).toBe(true);
        expect(Number.isFinite(outR[i])).toBe(true);
      }
    }
  });

  it("DELAY mode produces an echo at the configured time", () => {
    const { outL, proc } = render({
      seconds: 0.5,
      input: twoTone,
      params: { mode: 0, feedback: 0, time: 100, mix: 1, diffuse: 0 },
    });
    const delaySec = 0.1;
    const windowSec = 0.01;
    // The first repeat must arrive no earlier than the delay, and once the
    // window is open the level must be in the neighbourhood of the dry signal.
    const earlyRms = rms(outL, 0, Math.floor(0.06 * SR));
    const lateRms = rms(outL, Math.floor(0.14 * SR), Math.floor((0.14 + windowSec) * SR));
    expect(earlyRms).toBeLessThan(1e-6);
    expect(lateRms).toBeGreaterThan(0.05);
    expect(lateRms).toBeLessThan(1.5);
    // The engine reports which delay it engaged, so a TIME that silently failed
    // to reach the bank shows up as a number that does not match the knob.
    expect(proc.getMeters().delaySec).toBeCloseTo(delaySec, 3);
  });

  it("positive SHIFT maps a delayed partial up by one octave", () => {
    const params = { timeSec: 0.02, feedback: 0, decay: 0, shiftSemitones: 0, diffuse: 0, freeze: 0 };
    const renderOneDelayFrame = (shiftSemitones: number) => {
      const bank = new SpectralDelayBank(513, SR, 256);
      const frameParams = { ...params, shiftSemitones };
      let output = new Float64Array(513);
      for (let frame = 0; frame < 5; frame++) {
        const re = new Float64Array(513);
        const im = new Float64Array(513);
        if (frame === 0) re[5] = 1;
        bank.process(re, im, 513, frameParams, SR, 256);
        if (frame === 4) output = re;
      }
      return output;
    };
    const flat = renderOneDelayFrame(0);
    const up = renderOneDelayFrame(12);
    expect(flat[5]).toBeCloseTo(1, 6);
    expect(up[10]).toBeCloseTo(0.5, 6);
    expect(up[5]).toBe(0);
  });

  it("fractional SHIFT interpolates a delayed partial between neighboring bins", () => {
    const params = { timeSec: 0.02, feedback: 0, decay: 0, shiftSemitones: 7, diffuse: 0, freeze: 0 };
    const bank = new SpectralDelayBank(513, SR, 256);
    let output = new Float64Array(513);
    for (let frame = 0; frame < 5; frame++) {
      const re = new Float64Array(513);
      const im = new Float64Array(513);
      if (frame === 0) re[5] = 1;
      bank.process(re, im, 513, params, SR, 256);
      if (frame === 4) output = re;
    }

    // +7 st maps source bin 5 to 7.4915. Linear complex interpolation splits
    // the transposed partial according to its fractional destination position.
    expect(output[7]).toBeCloseTo(0.448466, 5);
    expect(output[8]).toBeCloseTo(0.440925, 5);
    expect(output[7]).toBeGreaterThan(output[8]);
    expect(output[6]).toBeCloseTo(0.003016, 5);
    expect(output[9]).toBe(0);
  });

  it("smooths automated SHIFT in audio time but starts static presets at their saved value", () => {
    const automated = new SpectralProcessor();
    automated.setParams({ ...DEFAULT_SPECTRAL_PARAMS, mode: 0, shift: 0, mix: 1, feedback: 0, diffuse: 0 });
    automated.prepare(SR);
    const input = new Float32Array(BLOCK).fill(0.1);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    automated.setParams({ shift: 12 });

    automated.process(input, input, outL, outR, BLOCK);
    const firstBlockShift = automated.getMeters().shiftSemitones;
    expect(firstBlockShift).toBeGreaterThan(0);
    expect(firstBlockShift).toBeLessThan(12);

    for (let block = 0; block < 200; block++) automated.process(input, input, outL, outR, BLOCK);
    expect(automated.getMeters().shiftSemitones).toBeCloseTo(12, 2);

    const staticPreset = new SpectralProcessor();
    staticPreset.setParams({ ...DEFAULT_SPECTRAL_PARAMS, mode: 0, shift: 12, mix: 1 });
    staticPreset.prepare(SR);
    staticPreset.process(input, input, outL, outR, BLOCK);
    expect(staticPreset.getMeters().shiftSemitones).toBe(12);
  });

  it("is bit-identical across repeated renders (NEW-EFFECT-CHECKLIST §10)", () => {
    const params = { mode: 0, feedback: 0.7, mix: 1, time: 250, diffuse: 0.8 } as const;
    const a = render({ seconds: 0.3, input: twoTone, params });
    const b = render({ seconds: 0.3, input: twoTone, params });
    const c = render({ seconds: 0.3, input: twoTone, params });
    expect(Array.from(b.outL)).toEqual(Array.from(a.outL));
    expect(Array.from(c.outL)).toEqual(Array.from(a.outL));
    expect(Array.from(c.outR)).toEqual(Array.from(a.outR));
  });

  it("DELAY golden vector is pinned", () => {
    const { outL, proc } = render({
      seconds: 0.25,
      input: twoTone,
      params: { mode: 0, time: 200, feedback: 0.6, decay: 0.5, diffuse: 0, mix: 1 },
    });
    const samples = [0, 1, 2, 10, 100, 1000, 5000, 9000, 11000].map((i) => q(outL[i]));
    expect({
      samples,
      peak: q(peakOf(outL)),
      frames: proc.getMeters().frames,
      latency: proc.latencySamples(),
    }).toEqual({
      samples: [0, 0, 0, 0, 0, 0, 0, 0, 0.120026],
      peak: 0.494242,
      frames: 46,
      latency: 768,
    });
  });

  it("RESONATOR golden vector is pinned", () => {
    const { outL } = render({
      seconds: 0.25,
      input: twoTone,
      params: { mode: 1, resonance: 0.8, focus: 660, focusWidth: 1, mix: 1 },
    });
    expect({ peak: q(peakOf(outL)), rms: q(rms(outL, 0, outL.length)) }).toEqual({ peak: 0.422945, rms: 0.237657 });
  });

  it("RESONATOR preserves focused on-bin and off-bin partials without phase combing", () => {
    const bins = [12, 12.25, 12.5, 13, 14, 15, 16, 17, 18];
    for (const bin of bins) {
      const frequency = (bin * SR) / 1024;
      const { outL } = render({
        seconds: 0.3,
        input: (i) => (i < 0.3 * SR ? 0.2 * Math.sin((2 * Math.PI * frequency * i) / SR) : 0),
        params: { mode: 1, resonance: 0.8, focus: frequency, focusWidth: 0.1, mix: 1 },
      });
      const activeRms = rms(outL, Math.floor(0.12 * SR), Math.floor(0.25 * SR));
      expect(activeRms, `focused bin ${bin} at ${frequency.toFixed(2)} Hz`).toBeGreaterThan(0.13);
      expect(activeRms, `focused bin ${bin} at ${frequency.toFixed(2)} Hz`).toBeLessThan(0.15);
    }
  });

  it("RESONATOR with zero resonance adds no hidden delay beyond reported STFT latency", () => {
    const quietTone = (i: number) => twoTone(i) * 0.001;
    const { outL, proc } = render({ seconds: 0.25, input: quietTone, params: { mode: 1, resonance: 0, mix: 1 } });
    const referenceEngine = new StftEngine(SR);
    referenceEngine.onFrame(() => {});
    const reference = new Float32Array(outL.length);
    const inputBlock = new Float32Array(MAX_BLOCK);
    const outputBlock = new Float32Array(MAX_BLOCK);
    for (let offset = 0; offset < reference.length; offset += MAX_BLOCK) {
      const len = Math.min(MAX_BLOCK, reference.length - offset);
      for (let i = 0; i < len; i++) inputBlock[i] = quietTone(offset + i);
      referenceEngine.processBlock(inputBlock, len, outputBlock);
      reference.set(outputBlock.subarray(0, len), offset);
    }
    let maxError = 0;
    for (let i = 0; i < outL.length; i++) maxError = Math.max(maxError, Math.abs(outL[i]! - reference[i]!));
    expect(proc.latencySamples()).toBe(referenceEngine.latencySamples());
    expect(maxError).toBeLessThan(1e-5);
  });

  it("FREEZE golden vector is pinned", () => {
    const { outL } = render({
      seconds: 0.4,
      input: twoTone,
      params: { mode: 2, feedback: 0.5, time: 120, mix: 1 },
    });
    expect({ peak: q(peakOf(outL)) }).toEqual({ peak: 0.090957 });
  });
});
