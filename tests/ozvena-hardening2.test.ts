/**
 * Ozvena core hardening regression suite #2 — one test per confirmed defect
 * fixed in the 2026-09-12 hardening pass. Each test pins the FIXED behavior
 * and fails on the pre-fix code path.
 *
 * Covered:
 *  1. reflectionsEngine: the tap-crossfade old-distance read is wrapped
 *     with a double modulo. Sweeping E1 time DOWN (e.g. 250 ms → 40 ms)
 *     shrank maxLen below the previous layout's distances; the single
 *     wrap-add still landed negative, read `undefined`, and NaN-latched the
 *     tap LPF state — those taps went permanently silent (they never
 *     recovered, even after the time returned).
 *  2. dsp/biquad setLowShelf/setHighShelf guard Q (q = 0 produced ±Infinity
 *     beta → NaN coefficients that poisoned the wet bus).
 *  3. dsp/math clamp() is NaN-safe (NaN → lower bound): one non-finite
 *     parameter no longer poisons every derived coefficient it touches.
 *  4. hallEngine/plateChamberEngine: a NaN attack envelope heals on the
 *     next recompute instead of latching forever (`attackEnv < 1` is false
 *     for NaN, so the old build-up branch never ran).
 *  5. duckController: non-finite attack/release times can no longer produce
 *     NaN or diverging envelope coefficients.
 *  6. preDelay: NaN ms degrades to 0 instead of reading dly[NaN].
 *  7. ozvenaProcessor: the final output stage contains residual NaN/Inf
 *     (the safety limiter's peak comparisons treat NaN as "no peak" and
 *     re-emit poisoned samples verbatim).
 *  8. fft.magnitudeSpectrum: an oversized scratch is viewed at exactly N
 *     samples — stale bins beyond N no longer participate in the transform.
 */
import { describe, expect, it } from "vitest";
import { createReflectionsEngine } from "../src/effects/ozvena-core/engines/reflectionsEngine.js";
import {
  defaultReflectionsEngine,
  defaultHallEngine,
  defaultPlateChamberEngine,
  defaultOzvenaStateV1,
} from "../src/effects/ozvena-core/v2/types.js";
import { createHallEngine } from "../src/effects/ozvena-core/engines/hallEngine.js";
import { createPlateChamberEngine } from "../src/effects/ozvena-core/engines/plateChamberEngine.js";
import { createBiquad, setLowShelf, setHighShelf } from "../src/effects/ozvena-core/dsp/biquad.js";
import { clamp } from "../src/effects/ozvena-core/dsp/math.js";
import { createDuckController } from "../src/effects/ozvena-core/core/duckController.js";
import { createPreDelay } from "../src/effects/ozvena-core/modules/preDelay.js";
import { createOzvenaProcessor } from "../src/effects/ozvena-core/core/ozvenaProcessor.js";
import { magnitudeSpectrum, hannWindow } from "../src/effects/ozvena-core/dsp/fft.js";

const SR = 48000;
const BLOCK = 128;

/** Deterministic xorshift noise in [-1, 1). */
function noiseSource(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

function blockOf(gen: () => number, out?: Float32Array[]): Float32Array[] {
  const chans = out ?? [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  chans[0].fill(0);
  chans[1].fill(0);
  for (let i = 0; i < BLOCK; i++) {
    const v = gen();
    chans[0][i] = v;
    chans[1][i] = v;
  }
  return chans;
}

function tailRms(chans: Float32Array[]): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += chans[0][i] * chans[0][i] + chans[1][i] * chans[1][i];
  return Math.sqrt(sum / (2 * BLOCK));
}

describe("ozvena-core hardening #2 — reflections tap crossfade", () => {
  it("a 250→40→250 ms time sweep does not kill reflection taps", () => {
    const makeEngine = () => {
      const eng = createReflectionsEngine();
      eng.prepare(SR, 2);
      eng.setParams({ ...defaultReflectionsEngine(), enabled: true, time: 250 });
      return eng;
    };

    // Engine A sweeps time down then back up; engine B stays at 250 ms.
    // Both then render the IDENTICAL final noise segment; the tails must
    // match closely. Pre-fix, the down-sweep NaN-latched most taps forever
    // (old tap distances > the shrunken maxLen read bufferL[negative]),
    // so A's tail collapsed relative to B's.
    const swept = makeEngine();
    const noise = noiseSource(0xc0ffee);
    // Warm up at 250 ms (arms subsequent crossfades).
    for (let b = 0; b < 64; b++) swept.process(blockOf(noise), BLOCK);
    swept.setParams({ ...defaultReflectionsEngine(), enabled: true, time: 40 });
    for (let b = 0; b < 64; b++) swept.process(blockOf(noise), BLOCK);
    swept.setParams({ ...defaultReflectionsEngine(), enabled: true, time: 250 });

    const steady = makeEngine();
    for (let b = 0; b < 64; b++) steady.process(blockOf(noiseSource(0xc0ffee)), BLOCK);

    // Identical final segment for both engines.
    const segment = noiseSource(0x5eed);
    const renderTail = (eng: ReturnType<typeof createReflectionsEngine>) => {
      let energy = 0;
      let n = 0;
      for (let b = 0; b < 128; b++) {
        const out = blockOf(segment);
        eng.process(out, BLOCK);
        if (b >= 64) {
          energy += tailRms(out) ** 2;
          n++;
        }
      }
      return Math.sqrt(energy / n);
    };
    const tailSwept = renderTail(swept);
    const tailSteady = renderTail(steady);
    expect(tailSwept).toBeGreaterThan(0);
    // The swept engine's tail must be within 40% of the untouched engine's.
    expect(tailSwept).toBeGreaterThan(0.6 * tailSteady);
  });
});

describe("ozvena-core hardening #2 — shelf Q guard", () => {
  it("setLowShelf/setHighShelf produce finite coefficients even at q = 0", () => {
    for (const set of [setLowShelf, setHighShelf]) {
      const bq = createBiquad(1);
      set(bq.coeffs, 1000, 0, 6, SR);
      for (const v of Object.values(bq.coeffs)) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // Impulse response stays finite (pre-fix the NaN coefficients fed
      // NaN straight into the wet bus).
      let last = 0;
      let worst = 0;
      for (let i = 0; i < 256; i++) {
        const x = i === 0 ? 1 : 0;
        const y = bq.coeffs.b0 * x + bq.z1[0];
        bq.z1[0] = bq.coeffs.b1 * x - bq.coeffs.a1 * y + bq.z2[0];
        bq.z2[0] = bq.coeffs.b2 * x - bq.coeffs.a2 * y;
        worst = Math.max(worst, Math.abs(y));
        last = y;
      }
      expect(Number.isFinite(last)).toBe(true);
      expect(worst).toBeLessThan(10);
    }
  });
});

describe("ozvena-core hardening #2 — NaN-safe clamp + engine heal", () => {
  it("clamp(NaN, min, max) degrades to the lower bound", () => {
    expect(clamp(NaN, 0, 1)).toBe(0);
    expect(clamp(NaN, -20, 20)).toBe(-20);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(5, 0, 1)).toBe(1);
  });

  it("a NaN attack parameter cannot permanently silence the hall/plate engines", () => {
    type MinimalEngine = {
      prepare(sampleRate: number, channelCount: number): void;
      process(channels: Float32Array[], frameCount: number): void;
      setParams(p: unknown): void;
    };
    const expectRecovery = (
      create: () => MinimalEngine,
      defaults: () => object,
    ): void => {
      const eng = create();
      eng.prepare(SR, 2);
      // One bad parameter ride (pre-fix: NaN alpha → NaN attackEnv latch →
      // NaN output forever) followed by a valid setParams.
      eng.setParams({ ...defaults(), enabled: true, attack: NaN });
      eng.process(blockOf(noiseSource(1)), BLOCK);
      eng.setParams({ ...defaults(), enabled: true });
      let peak = 0;
      for (let b = 0; b < 64; b++) {
        const out = blockOf(noiseSource(0xab + b));
        eng.process(out, BLOCK);
        for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(out[0][i]));
      }
      expect(Number.isFinite(peak)).toBe(true);
      expect(peak).toBeGreaterThan(0);
    };
    expectRecovery(createHallEngine, defaultHallEngine);
    expectRecovery(createPlateChamberEngine, defaultPlateChamberEngine);
  });
});

describe("ozvena-core hardening #2 — duck controller", () => {
  it("non-finite attack times cannot NaN or diverge the duck gain", () => {
    const duck = createDuckController();
    duck.setParams({ enabled: true, attackMs: NaN, releaseMs: Infinity });
    duck.processNotification({ fromInstanceId: 1, fromKind: "fxeq", magDb: 0, freqHz: 1000, timestamp: 0 });
    for (let b = 0; b < 400; b++) {
      const g = duck.getGain(SR, BLOCK);
      expect(Number.isFinite(g)).toBe(true);
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("ozvena-core hardening #2 — preDelay NaN ms", () => {
  it("NaN ms degrades to 0 and the delay line stays finite", () => {
    const pd = createPreDelay();
    pd.prepare(SR, 2, 120);
    const defaults = defaultOzvenaStateV1().preDelay;
    pd.setParams({ ...defaults, enabled: true, ms: NaN });
    const gen = noiseSource(0xd00d);
    for (let b = 0; b < 16; b++) {
      const out = blockOf(gen);
      pd.process(out, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(out[0][i])).toBe(true);
        expect(Number.isFinite(out[1][i])).toBe(true);
      }
    }
  });
});

describe("ozvena-core hardening #2 — processor output poison guard", () => {
  it("the final output stage never emits non-finite samples", () => {
    const proc = createOzvenaProcessor();
    proc.prepare(SR, 2, 120, BLOCK);
    const state = defaultOzvenaStateV1();
    proc.loadState({ ...state, global: { ...state.global, dryWet: 40 } });
    const gen = noiseSource(0xbeef);
    for (let b = 0; b < 64; b++) {
      const out = blockOf(gen);
      proc.process(out, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(out[0][i])).toBe(true);
        expect(Number.isFinite(out[1][i])).toBe(true);
      }
    }
  });
});

describe("ozvena-core hardening #2 — magnitudeSpectrum scratch", () => {
  it("an oversized scratch does not contaminate the spectrum", () => {
    const N = 2048;
    const window = hannWindow(N);
    const out = new Float32Array(N / 2 + 1);
    // A full-scale sine centered on bin 32.
    const signal = new Float32Array(N);
    for (let i = 0; i < N; i++) signal[i] = Math.sin((2 * Math.PI * 32 * i) / N);

    // Reused scratches that are LARGER than N, pre-filled with garbage
    // beyond N (the fft() call transforms re.length — the old code dragged
    // bins N..4096 into the transform).
    const staleRe = new Float64Array(4096);
    const staleIm = new Float64Array(4096);
    staleRe.fill(7);
    magnitudeSpectrum(signal, window, out, staleRe, staleIm);
    const k32 = out[32];
    expect(k32).toBeGreaterThan(0.9);
    expect(k32).toBeLessThan(1.1);

    // Exact-length scratch gives the identical answer.
    const out2 = new Float32Array(N / 2 + 1);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    magnitudeSpectrum(signal, window, out2, re, im);
    expect(out2[32]).toBeCloseTo(k32, 9);
  });
});
