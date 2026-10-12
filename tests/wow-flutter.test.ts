/**
 * WOW & FLUTTER — headless DSP tests (2026-10-12).
 *
 * These run the REAL processor source, not a re-implementation of it: the
 * module is imported with the worklet globals stubbed and the class captured
 * from `registerProcessor`, then `process()` is driven in 128-sample blocks
 * exactly as an AudioWorklet host would.
 *
 * ── Why the measurement is a delay, not a pitch ─────────────────────────────
 * The effect's product claim is that its depth control reads in CENTS and
 * delivers that pitch deviation. Measuring pitch out of a rendered sine is a
 * bad instrument: a 60 ms zero-crossing window at 440 Hz holds ~26 crossings, so
 * frequency quantises in ~4% (~66 cent) steps, and a small noisy envelope reads
 * as a fast sign-flipping series. An earlier version of the browser spec did
 * exactly that and reported a requested 1 Hz wobble as 1.91 Hz.
 *
 * The effect modulates a delay, so measure the delay. Feed isolated impulses:
 * the read is a LINEAR interpolation between two ring samples, so an impulse of
 * amplitude 1 at fractional position f lands as exactly [1-f, f] — the
 * amplitude sums to 1 either way, which makes the amplitude CENTROID recover f
 * with no interpolation bias at all. Then the pitch deviation follows
 * analytically from the read position r(t) = t - D(t):
 *
 *     frequency ratio = dr/dt = 1 - dD/dt        (dD/dt is dimensionless)
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * The cents->amplitude conversion multiplied by the base delay, which is the
 * granular/resampling law `dD/dt / D`. A continuously modulated delay line is
 * not that: the spurious factor made the control exactly `1/baseDelay` too
 * weak, and a `wobble * 0.5` in the offset halved it again. Measured: a 10-cent
 * depth moved the pitch 0.02 cents — 500x short. The depth tests below fail if
 * either half of that comes back.
 */

import { beforeAll, describe, expect, it } from "vitest";

const SR = 44100;
const BLOCK = 128;

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(_message: unknown) {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface ProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

let Processor: new (options?: unknown) => ProcessorLike;
// Assigned in beforeAll: the import must happen AFTER the worklet globals are
// stubbed, so it cannot be a top-level await.
let wfCentsToAmplitudeSeconds: (cents: number, rateHz: number) => number;
let wfAchievableCents: (cents: number, rateHz: number, maxAmplitudeSeconds: number) => number;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { currentTime: number }).currentTime = 0;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  const registry = new Map<string, new (options?: unknown) => ProcessorLike>();
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: unknown) => {
    registry.set(name, cls as new (options?: unknown) => ProcessorLike);
  };
  // The raw worklet processor is plain JS with no type declarations, so vitest
  // resolves it through the module graph like every other worklet test here.
  const mod = await import("../src/audio-worklets/wowflutter-processor.js");
  wfCentsToAmplitudeSeconds = mod.wfCentsToAmplitudeSeconds;
  wfAchievableCents = mod.wfAchievableCents;
  const found = registry.get("wowflutter-processor");
  if (!found) throw new Error("wowflutter-processor was not registered");
  Processor = found;
});

/** Parameters as the host delivers them: one Float32Array per name. */
function paramBlock(values: Record<string, number>, defaults: Record<string, number>) {
  const all: Record<string, number> = { ...defaults, ...values };
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(all)) out[k] = new Float32Array([v]);
  return out;
}

const DEFAULTS = {
  wowRate: 0.5,
  wowDepth: 10,
  flutterRate: 11,
  flutterDepth: 2.5,
  drift: 0.35,
  mix: 1,
  output: 0,
};

function renderImpulseTrain(params: Record<string, number>, seconds: number, seed = 12345) {
  const frames = Math.ceil(seconds * SR);
  const impulseSamples = Math.round(SR / 200); // 200 Hz
  const trainStart = Math.floor(0.3 * SR);
  // An isolated seed impulse well before the train. It is the only thing whose
  // output lies in the first 30 ms, which is what makes the absolute delay
  // unambiguous: the train's own first output lands ~2200 samples later.
  const seedAt = trainStart - 10 * impulseSamples;
  const input = new Float32Array(frames);
  input[seedAt] = 1;
  // Stop writing early enough that EVERY impulse's output lands fully inside
  // the render, including the largest delay the ring can produce. A truncated
  // tail impulse loses part of its energy and reads as lost energy.
  const lastWrite = frames - Math.ceil(0.08 * SR);
  let impulseCount = 0;
  for (let w = trainStart; w < lastWrite; w += impulseSamples) {
    input[w] = 1;
    impulseCount++;
  }

  const proc = new Processor({ processorOptions: { seed } });
  const blocks = Math.ceil(frames / BLOCK);
  const rendered = new Float32Array(frames);
  for (let b = 0; b < blocks; b++) {
    const start = b * BLOCK;
    const len = Math.min(BLOCK, frames - start);
    const inL = input.subarray(start, start + len);
    const inR = inL;
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    const p = paramBlock(params, DEFAULTS);
    proc.process([[inL, inR]], [[outL, outR]], p);
    rendered.set(outL, start);
  }
  return { rendered, impulseSamples, trainStart, seedAt, impulseCount };
}

/**
 * Recover the delay of each impulse by amplitude centroid, tracked by
 * continuity. The search window is kept narrower than one impulse spacing so it
 * can never lock onto a neighbouring impulse.
 */
function measureDelay(rendered: Float32Array, impulseSamples: number, trainStart: number, seedAt: number) {
  const centroid = (from: number, to: number) => {
    let imax = -1;
    let best = 0;
    const lo = Math.max(0, Math.ceil(from));
    const hi = Math.min(rendered.length - 1, Math.floor(to));
    for (let i = lo; i <= hi; i++) {
      const v = Math.abs(rendered[i]);
      if (v > best) {
        best = v;
        imax = i;
      }
    }
    if (imax < 0 || best < 0.5) return NaN;
    let num = 0;
    let den = 0;
    for (let i = imax - 1; i <= imax + 2; i++) {
      const v = rendered[i];
      if (v > 0) {
        num += i * v;
        den += v;
      }
    }
    return den > 0 ? num / den : NaN;
  };

  // Absolute reference from the isolated seed impulse.
  const seedC = centroid(seedAt, seedAt + Math.ceil(0.03 * SR));
  if (!Number.isFinite(seedC)) return null;
  const seedDelay = seedC - seedAt;

  const deltas: number[] = [];
  let prevD = seedDelay;
  const search = Math.floor(impulseSamples / 2) - 6;

  for (let w = trainStart; w + impulseSamples < rendered.length; w += impulseSamples) {
    const seedPos = w + prevD;
    const c = centroid(seedPos - search, seedPos + search);
    if (!Number.isFinite(c)) continue;
    prevD = c - w;
    deltas.push(prevD);
  }
  return deltas;
}

/** Pitch deviation in cents implied by the measured delay trajectory. */
function deviationCents(deltas: number[], impulseSamples: number) {
  const hop = impulseSamples / SR;
  const cents: number[] = [];
  for (let i = 1; i < deltas.length; i++) {
    const dDdt = (deltas[i] - deltas[i - 1]) / hop / SR; // dimensionless
    const ratio = 1 - dDdt;
    if (ratio > 0) cents.push(1200 * Math.log2(ratio));
  }
  return cents;
}

/**
 * Amplitude of the deviation in cents. A sinusoidal deviation of amplitude A
 * has rms A/sqrt(2). rms is the robust estimator: the single-sample peak
 * over-read by ~1.9x on a lightly sampled quasi-sine while rms tracked the
 * request to within 1%.
 */
function deviationAmplitude(cents: number[]) {
  const rms = Math.sqrt(cents.reduce((a, c) => a + c * c, 0) / cents.length);
  return rms * Math.SQRT2;
}

/** Wobble rate in Hz: a sine gives one up-crossing and one down-crossing per cycle. */
function deviationRate(cents: number[], impulseSamples: number) {
  let crossings = 0;
  for (let i = 1; i < cents.length; i++) {
    if ((cents[i - 1] <= 0 && cents[i] > 0) || (cents[i - 1] >= 0 && cents[i] < 0)) crossings++;
  }
  const spanSec = ((cents.length + 1) * impulseSamples) / SR;
  return crossings / 2 / spanSec;
}

function measure(params: Record<string, number>, seconds: number) {
  const { rendered, impulseSamples, trainStart, seedAt } = renderImpulseTrain(params, seconds);
  const deltas = measureDelay(rendered, impulseSamples, trainStart, seedAt);
  if (!deltas || deltas.length < 8) throw new Error("delay tracking lost the impulse train");
  const cents = deviationCents(deltas, impulseSamples);
  return {
    deltas,
    cents,
    amplitude: deviationAmplitude(cents),
    rate: deviationRate(cents, impulseSamples),
    minDelay: Math.min(...deltas) / SR,
    maxDelay: Math.max(...deltas) / SR,
  };
}

describe("wow & flutter — cents conversion", () => {
  it("does NOT scale by the base delay (the granular resampling law does not apply here)", () => {
    // The whole defect in one assertion: a conversion that multiplied by a
    // 4 ms base delay would return 4e-3 * deviation / (2*pi*f), i.e. 250x more.
    const amp = wfCentsToAmplitudeSeconds(10, 0.5);
    expect(amp).toBeGreaterThan(0);
    const expected = (1 - Math.pow(2, -10 / 1200)) / (2 * Math.PI * 0.5);
    expect(amp).toBeCloseTo(expected, 12);
  });

  it("scales inversely with rate: the same cents at half the rate needs twice the swing", () => {
    expect(wfCentsToAmplitudeSeconds(10, 0.25) / wfCentsToAmplitudeSeconds(10, 0.5)).toBeCloseTo(2, 6);
  });

  it("is zero depth for zero cents and refuses garbage input", () => {
    expect(wfCentsToAmplitudeSeconds(0, 1)).toBe(0);
    expect(wfCentsToAmplitudeSeconds(NaN, 1)).toBe(0);
    expect(wfCentsToAmplitudeSeconds(10, NaN)).toBe(0);
    // A zero rate is floored to 1e-4 Hz rather than producing Infinity. The
    // processor clamps wowRate to >= 0.05 before calling this, so the floored
    // case only has to stay finite.
    const floored = wfCentsToAmplitudeSeconds(10, 0);
    expect(Number.isFinite(floored)).toBe(true);
    expect(floored).toBeGreaterThan(0);
  });

  it("round-trips through wfAchievableCents when the budget is not binding", () => {
    expect(wfAchievableCents(20, 1, 0.05)).toBeCloseTo(20, 9);
    // Binding budget: reports the truth instead of the request.
    expect(wfAchievableCents(60, 0.05, 0.0099)).toBeLessThan(6);
    expect(wfAchievableCents(60, 0.05, 0.0099)).toBeGreaterThan(0);
  });
});

describe("wow & flutter — measured behaviour", () => {
  it("depth 0 with drift 0 is exactly transparent: zero deviation, constant delay", () => {
    const m = measure({ wowDepth: 0, flutterDepth: 0, drift: 0 }, 3);
    expect(m.amplitude).toBeLessThan(0.01);
    // Constant to the last counted sample — the wobble terms are all off.
    expect(m.maxDelay - m.minDelay).toBeLessThan(1e-6);
  });

  it("depth 10 at 0.5 Hz delivers 10 cents", () => {
    const m = measure({ wowDepth: 10, flutterDepth: 0, drift: 0, wowRate: 0.5 }, 6);
    expect(m.amplitude).toBeGreaterThan(8.5);
    expect(m.amplitude).toBeLessThan(11.5);
  });

  it("depth 30 at 0.5 Hz delivers 30 cents", () => {
    const m = measure({ wowDepth: 30, flutterDepth: 0, drift: 0, wowRate: 0.5 }, 6);
    expect(m.amplitude).toBeGreaterThan(25.5);
    expect(m.amplitude).toBeLessThan(34.5);
  });

  it("depth scales with the knob across the range", () => {
    for (const depth of [2, 5, 20, 40]) {
      const m = measure({ wowDepth: depth, flutterDepth: 0, drift: 0, wowRate: 0.5 }, 6);
      expect(m.amplitude / depth).toBeGreaterThan(0.85);
      expect(m.amplitude / depth).toBeLessThan(1.15);
    }
  });

  it("flutter 10 at 11 Hz delivers 10 cents at 11 Hz", () => {
    const m = measure({ wowDepth: 0, flutterDepth: 10, drift: 0, flutterRate: 11 }, 6);
    expect(m.amplitude).toBeGreaterThan(8.5);
    expect(m.amplitude).toBeLessThan(11.5);
    expect(m.rate).toBeGreaterThan(10);
    expect(m.rate).toBeLessThan(12);
  });

  it("the wow rate knob sets the rate", () => {
    const m = measure({ wowDepth: 25, flutterDepth: 0, drift: 0, wowRate: 1 }, 8);
    expect(m.rate).toBeGreaterThan(0.9);
    expect(m.rate).toBeLessThan(1.1);
    expect(m.amplitude).toBeGreaterThan(22);
    expect(m.amplitude).toBeLessThan(28);
  });

  it("drift is a bounded slow wander, not a pitch catastrophe", () => {
    // Regression: drift used to be 35% of the whole 56 ms ring, which swung the
    // delay by 19.6 ms and measured at 650 cents.
    const m = measure({ wowDepth: 0, flutterDepth: 0, drift: 1 }, 6);
    expect(m.amplitude).toBeGreaterThan(0.2);
    expect(m.amplitude).toBeLessThan(8);
    expect(Math.max(m.maxDelay, -m.minDelay)).toBeLessThan(0.02); // never a 20 ms swing
  });

  it("drift is deterministic for a given seed (live/offline identity)", () => {
    const a = measure({ wowDepth: 5, flutterDepth: 0, drift: 1 }, 4);
    const b = measure({ wowDepth: 5, flutterDepth: 0, drift: 1 }, 4);
    expect(b.deltas).toEqual(a.deltas);
    const c = renderImpulseTrain({ wowDepth: 5, flutterDepth: 0, drift: 1 }, 4, 999);
    const cDeltas = measureDelay(c.rendered, c.impulseSamples, c.trainStart, c.seedAt);
    expect(cDeltas).not.toEqual(a.deltas);
  });

  it("the read never wraps: the worst corner stays inside the ring and clean", () => {
    const { rendered, impulseSamples, trainStart, seedAt, impulseCount } = renderImpulseTrain(
      { wowRate: 0.05, wowDepth: 60, flutterRate: 60, flutterDepth: 20, drift: 1 },
      8,
    );
    const deltas = measureDelay(rendered, impulseSamples, trainStart, seedAt);
    expect(deltas).not.toBeNull();
    const min = Math.min(...(deltas as number[])) / SR;
    const max = Math.max(...(deltas as number[])) / SR;
    // Base delay 10 ms plus at most the swing budget: the read offset is
    // `base + swing/2 + wobble`, so it must stay well inside DELAY_SECONDS.
    // Measured worst corner: 5.0 .. 24.9 ms.
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(0.03);
    // A wrapped read lands on unwritten ring memory and would show up as a delay in
    // the far side of the ring (already excluded above), as a lost impulse, or
    // as stacked garbage.
    //
    // Two earlier versions of the checks below were wrong and are worth
    // recording. Summing a two-sample window per impulse read ~f or ~1-f,
    // depending on which element of the interpolant pair was the peak. Requiring
    // every nonzero run to be exactly 2 samples also fails, and not because of a
    // defect: at this corner the delay falls to ~220 samples, which IS the input
    // spacing, so output impulses legitimately land ADJACENT and merge into a
    // 4-sample run (measured: 20 such merges out of 1529 impulses).
    //
    // What does hold exactly: the tracker finds essentially every impulse, so
    // none was dropped or doubled, and the output never exceeds the input peak.
    expect(deltas).not.toBeNull();
    expect((deltas as number[]).length).toBeGreaterThan(impulseCount * 0.98);

    let peak = 0;
    for (let i = 0; i < rendered.length; i++) peak = Math.max(peak, Math.abs(rendered[i]));
    expect(peak).toBeLessThan(1.0001);

    // Whole-buffer energy, to a few percent. The per-impulse split is
    // (1-f, f') with f' != f because the offset moves between the two samples
    // that share one impulse, so per-impulse energy varies by -0.7%..+1.4% and
    // over 1529 impulses those differences random-walk with sigma ~= 0.78 units
    // (measured +0.99). A wrap would instead lose whole impulses, which is far
    // outside this band.
    let energy = 0;
    for (let i = 0; i < rendered.length; i++) energy += Math.abs(rendered[i]);
    expect(Math.abs(energy - (impulseCount + 1))).toBeLessThan((impulseCount + 1) * 0.02);
  });

  it("both channels stay bit-identical (in-phase stereo)", () => {
    const frames = Math.ceil(2 * SR);
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) input[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
    const proc = new Processor({ processorOptions: { seed: 7 } });
    let maxDelta = 0;
    for (let b = 0; b * BLOCK < frames; b++) {
      const start = b * BLOCK;
      const len = Math.min(BLOCK, frames - start);
      const outL = new Float32Array(len);
      const outR = new Float32Array(len);
      proc.process([[input.subarray(start, start + len), input.subarray(start, start + len)]], [[outL, outR]], {
        wowRate: new Float32Array([1]),
        wowDepth: new Float32Array([40]),
        flutterRate: new Float32Array([17]),
        flutterDepth: new Float32Array([8]),
        drift: new Float32Array([1]),
        mix: new Float32Array([1]),
        output: new Float32Array([0]),
      });
      for (let i = 0; i < len; i++) maxDelta = Math.max(maxDelta, Math.abs(outL[i] - outR[i]));
    }
    expect(maxDelta).toBe(0);
  });

  it("mix 0 is a pure passthrough and output trims in decibels", () => {
    const frames = 4096;
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) input[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
    const run = (params: Record<string, number>) => {
      const proc = new Processor({ processorOptions: { seed: 3 } });
      const out = new Float32Array(frames);
      for (let b = 0; b * BLOCK < frames; b++) {
        const start = b * BLOCK;
        const len = Math.min(BLOCK, frames - start);
        const outL = new Float32Array(len);
        const p = paramBlock(params, DEFAULTS);
        proc.process([[input.subarray(start, start + len)]], [[outL]], p);
        out.set(outL, start);
      }
      return out;
    };
    const dry = run({ mix: 0 });
    for (let i = 0; i < frames; i++) expect(dry[i]).toBeCloseTo(input[i], 12);

    const quiet = run({ mix: 1, output: -6 });
    // A 0.5-amplitude sine at -6 dB is 0.2506 peak, and rms of a sine is
    // A/sqrt(2) = 0.1772. Measured 0.17806 — 0.5% high, which is the linear
    // interpolant's mild lowpass, not a level error.
    let sum = 0;
    let n = 0;
    for (let i = frames - 2048; i < frames; i++) {
      sum += quiet[i] * quiet[i];
      n++;
    }
    expect(Math.sqrt(sum / n)).toBeGreaterThan(0.172);
    expect(Math.sqrt(sum / n)).toBeLessThan(0.182);
  });

  it("survives a block with no input connected", () => {
    const proc = new Processor({ processorOptions: { seed: 1 } });
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    expect(proc.process([[]], [[outL, outR]], paramBlock({}, DEFAULTS))).toBe(true);
    for (let i = 0; i < BLOCK; i++) expect(outL[i]).toBe(0);
  });
});
