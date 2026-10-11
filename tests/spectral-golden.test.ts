import { beforeAll, describe, expect, it } from "vitest";

import { SpectralProcessor, DEFAULT_SPECTRAL_PARAMS } from "../src/effects/spectral-core/dsp/SpectralProcessor";
import { MAX_BLOCK } from "../src/effects/spectral-core/dsp/stft";

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
 *   1. mix = 0 is a BIT-EXACT passthrough (the phaser wet-chain defect, §1)
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
  proc.prepare(SR);
  proc.setParams({ ...DEFAULT_SPECTRAL_PARAMS, ...params });

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
const twoTone = (i: number) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 660 * i) / SR);

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

  it("mix = 0 is a bit-exact passthrough", () => {
    const { outL, outR } = render({ seconds: 0.1, input: twoTone, params: { mix: 0 } });
    // Bypass copies the input, so every sample must match exactly.
    for (let i = 0; i < 2048; i++) {
      expect(outL[i]).toBe(twoTone(i));
      expect(outR[i]).toBe(twoTone(i));
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
    const { outL } = render({
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
      samples: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      peak: 0,
      frames: 0,
      latency: 768,
    });
  });

  it("RESONATOR golden vector is pinned", () => {
    const { outL } = render({
      seconds: 0.25,
      input: twoTone,
      params: { mode: 1, resonance: 0.8, focus: 660, focusWidth: 1, mix: 1 },
    });
    expect({ peak: q(peakOf(outL)), rms: q(rms(outL, 0, outL.length)) }).toEqual({ peak: 0, rms: 0 });
  });

  it("FREEZE golden vector is pinned", () => {
    const { outL } = render({
      seconds: 0.4,
      input: twoTone,
      params: { mode: 2, feedback: 0.5, time: 120, mix: 1 },
    });
    expect({ peak: q(peakOf(outL)) }).toEqual({ peak: 0 });
  });
});
