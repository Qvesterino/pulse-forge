import { beforeAll, describe, expect, it } from "vitest";

/**
 * Aliasing + true-peak battery:
 *
 *  - Core limiter (`limiter-processor.js`): the 4× Blackman-sinc true-peak
 *    detector catches ceiling-exceeding INTERSAMPLE peaks a sample-peak
 *    detector cannot see (fs/4 sine isolation test), while ordinary sines
 *    behave exactly like the legacy detector (regression pin), latency stays
 *    exactly `lookahead`, mix = 0 is unity, extremes stay finite + bounded.
 *  - Cubic-hermite delay reads (flanger / comb / ducking-delay): echo timing
 *    incl. fractional delays, feedback decay, mix = 0 unity, bounded soak.
 *    (Stutter is intentionally excluded — its loop length is quantized to
 *    integer samples so the pitch never drifts; interpolation would detune
 *    it.)
 *
 * Processors run as REAL code under a stubbed AudioWorkletGlobalScope.
 * The WaveShaper 2×→4× upgrades (saturation/distortion/shimmer/bass/808/
 * logdrum/drumsynth) are browser-attribute changes exercised by the
 * Chromium browser suite; the registry contract pins their presence here
 * through the shared effect battery (tests/effects.test.ts).
 */

class FakePort {
  messages: unknown[] = [];
  onmessage: ((e: unknown) => void) | null = null;
  postMessage(msg: unknown) {
    this.messages.push(msg);
  }
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => any>();

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { currentTime: number }).currentTime = 0;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/limiter-processor.js");
  await import("../src/audio-worklets/flanger-processor.js");
  await import("../src/audio-worklets/comb-processor.js");
  await import("../src/audio-worklets/ducking-delay-processor.js");
  for (const name of ["limiter-processor", "flanger-processor", "comb-processor", "ducking-delay-processor"]) {
    expect(registered.get(name), name).toBeDefined();
  }
});

const BLOCK = 128;
const SR = 48000;

// Monotone stubbed worklet clock (never goes backward across renders in one
// file — the limiter snapshots it at construction for its GR cadence).
let fakeNow = 0;

function renderStereo(
  proc: any,
  seconds: number,
  prm: Record<string, Float32Array>,
  input: (n: number) => [number, number] = () => [0, 0],
): { L: Float32Array; R: Float32Array } {
  const nBlocks = Math.ceil((seconds * SR) / BLOCK);
  const L = new Float32Array(nBlocks * BLOCK);
  const R = new Float32Array(nBlocks * BLOCK);
  for (let b = 0; b < nBlocks; b++) {
    // Advance the stubbed worklet clock — the limiter's ~20 Hz GR meter
    // posts against currentTime like the real AudioWorkletGlobalScope.
    fakeNow += BLOCK / SR;
    (globalThis as unknown as { currentTime: number }).currentTime = fakeNow;
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const [l, r] = input(b * BLOCK + i);
      inL[i] = l;
      inR[i] = r;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inL, inR]], [[outL, outR]], prm);
    L.set(outL, b * BLOCK);
    R.set(outR, b * BLOCK);
  }
  return { L, R };
}

function params(names: string[], values: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const n of names) out[n] = Float32Array.from([values[n] ?? 0]);
  return out;
}

function peakAbs(buf: Float32Array, from = 0, to = buf.length): number {
  let m = 0;
  for (let i = from; i < to; i++) {
    const v = Math.abs(buf[i]);
    if (v > m) m = v;
  }
  return m;
}

const LIM = ["threshold", "ceiling", "release", "lookahead", "link", "mix"];

describe("limiter true-peak detector", () => {
  it("catches an intersample peak a sample detector cannot see", () => {
    // fs/4 sine at 45°: samples alternate ±A/√2, true peak A. With A = 1.2
    // the sample peak (−1.42 dBFS) sits UNDER threshold (−0.5 dB) — a legacy
    // sample-peak detector applies zero reduction — while the true peak
    // (+1.58 dBFS) exceeds the −1 dB ceiling and must pull gain down.
    const A = 1.2;
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, { threshold: -0.5, ceiling: -1, release: 0.05, lookahead: 0.005, link: 1, mix: 1 });
    const { L } = renderStereo(proc, 1, prm, (n) => {
      const v = A * Math.sin((Math.PI / 2) * n + Math.PI / 4);
      return [v, v];
    });
    const ceilingLin = Math.pow(10, -1 / 20);
    const peak = peakAbs(L, Math.floor(SR * 0.5));
    // Brickwall holds on TRUE peak: no output sample exceeds the ceiling…
    expect(peak).toBeLessThanOrEqual(ceilingLin * 1.001);
    // …the signal clearly passes (not muted by a runaway detector)…
    expect(peak).toBeGreaterThan(0.5);
    // …and the GR meter proves the detector saw the intersample overshoot
    // (a sample-only detector would have posted gr = 0 forever).
    const grMsgs = (proc.port.messages as { type?: string; gr?: number }[]).filter((m) => m?.type === "gr");
    expect(grMsgs.length).toBeGreaterThan(0);
    expect(Math.max(...grMsgs.map((m) => m.gr ?? 0))).toBeGreaterThan(1);
  });

  it("ordinary sines behave like the legacy detector (regression pin)", () => {
    // 440 Hz @48 kHz has negligible intersample overshoot (~0.001 dB), so
    // the true-peak path must pin the output at the ceiling exactly as the
    // browser acceptance suite expects (peak = ceiling, gr ≥ 3 dB).
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, { threshold: -18, ceiling: -6, release: 0.05, lookahead: 0.005, link: 1, mix: 1 });
    const { L } = renderStereo(proc, 1, prm, (n) => {
      const v = 0.9 * Math.sin((n / SR) * 440 * Math.PI * 2);
      return [v, v];
    });
    const ceilingLin = Math.pow(10, -6 / 20);
    const peak = peakAbs(L, Math.floor(SR * 0.5));
    expect(peak).toBeLessThanOrEqual(ceilingLin * 1.005);
    expect(peak).toBeGreaterThan(ceilingLin * 0.95);
    const grMsgs = (proc.port.messages as { type?: string; gr?: number }[]).filter((m) => m?.type === "gr");
    expect(Math.max(...grMsgs.map((m) => m.gr ?? 0))).toBeGreaterThan(3);
  });

  it("latency stays exactly lookahead and mix = 0 is unity", () => {
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, { threshold: -18, ceiling: -1, release: 0.05, lookahead: 0.005, link: 1, mix: 1 });
    const { L } = renderStereo(proc, 0.5, prm, (n) => (n === 0 ? [1, 1] : [0, 0]));
    const la = Math.round(0.005 * SR);
    expect(peakAbs(L, 0, la)).toBeLessThan(1e-6);
    expect(Math.abs(L[la])).toBeGreaterThan(0.5);

    const dry = new (registered.get("limiter-processor")!)();
    const dryPrm = params(LIM, { threshold: -18, ceiling: -1, release: 0.05, lookahead: 0.005, link: 1, mix: 0 });
    const out = renderStereo(dry, 0.3, dryPrm, () => [0.4, -0.3]);
    for (let i = la; i < out.L.length; i++) {
      expect(Math.abs(out.L[i] - 0.4)).toBeLessThan(1e-5);
      expect(Math.abs(out.R[i] + 0.3)).toBeLessThan(1e-5);
    }
  });

  it("extremes soak: finite, bounded, no NaN", () => {
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, { threshold: 0, ceiling: 0, release: 1, lookahead: 0.02, link: 0, mix: 1 });
    const { L, R } = renderStereo(proc, 1, prm, (n) => [Math.sin(n * 0.31) * 2.5, Math.cos(n * 0.17) * 2.5]);
    for (const buf of [L, R]) {
      for (let i = 0; i < buf.length; i++) {
        expect(Number.isFinite(buf[i])).toBe(true);
        expect(Math.abs(buf[i])).toBeLessThanOrEqual(1.001);
      }
    }
  });
});

describe("cubic delay reads", () => {
  it("comb lands repeats at delayMs incl. fractional delays and decays", () => {
    const proc = new (registered.get("comb-processor")!)();
    const prm = params(["delayMs", "feedback", "damp", "mix"], {
      delayMs: 4.3,
      feedback: 0.7,
      damp: 12000,
      mix: 1,
    });
    const { L } = renderStereo(proc, 1, prm, (n) => (n === 0 ? [1, 0] : [0, 0]));
    const at = 4.3 * (SR / 1000);
    expect(peakAbs(L, Math.floor(at) - 4, Math.floor(at) + 8)).toBeGreaterThan(0.2);
    expect(peakAbs(L, 0, Math.floor(at) - 8)).toBeLessThan(1e-5);
    // Feedback decay: late tail well under the first repeat.
    const first = peakAbs(L, Math.floor(at) - 4, Math.floor(at) + 8);
    const late = peakAbs(L, Math.floor(SR * 0.5));
    expect(late).toBeLessThan(first * 0.5);
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i])).toBe(true);
  });

  it("flanger modulates (output differs from input) and mix = 0 is unity", () => {
    const proc = new (registered.get("flanger-processor")!)();
    const prm = params(["rate", "depth", "base", "feedback", "spread", "mix"], {
      rate: 0.5,
      depth: 3,
      base: 5,
      feedback: 0.4,
      spread: 0.7,
      mix: 1,
    });
    const { L } = renderStereo(proc, 1, prm, (n) => {
      const v = 0.5 * Math.sin((n / SR) * 440 * Math.PI * 2);
      return [v, v];
    });
    // Comb filtering must reshape the sine — average deviation is large.
    let dev = 0;
    const from = Math.floor(SR * 0.2);
    for (let i = from; i < L.length; i++) {
      dev += Math.abs(L[i] - 0.5 * Math.sin((i / SR) * 440 * Math.PI * 2));
    }
    expect(dev / (L.length - from)).toBeGreaterThan(0.05);
    expect(peakAbs(L)).toBeLessThan(2);

    const dry = new (registered.get("flanger-processor")!)();
    const dryPrm = params(["rate", "depth", "base", "feedback", "spread", "mix"], {
      rate: 0.5,
      depth: 3,
      base: 5,
      feedback: 0.4,
      spread: 0.7,
      mix: 0,
    });
    const out = renderStereo(dry, 0.3, dryPrm, () => [0.4, 0.2]);
    for (let i = 0; i < out.L.length; i++) {
      expect(Math.abs(out.L[i] - 0.4)).toBeLessThan(1e-6);
      expect(Math.abs(out.R[i] - 0.2)).toBeLessThan(1e-6);
    }
  });

  it("ducking-delay echoes at delayMs, decays, mix = 0 is unity", () => {
    const proc = new (registered.get("ducking-delay-processor")!)();
    const prm = params(["time", "feedback", "tone", "duckAmount", "duckThresh", "duckAttack", "duckRelease", "mix"], {
      time: 110,
      feedback: 0.5,
      tone: 8000,
      duckThresh: -60,
      duckAttack: 0.005,
      duckRelease: 0.1,
      duckAmount: 0,
      mix: 1,
    });
    const { L } = renderStereo(proc, 1.5, prm, (n) => (n === 0 ? [1, 0] : [0, 0]));
    const at = Math.floor(0.11 * SR);
    expect(peakAbs(L, at - 8, at + 8)).toBeGreaterThan(0.2);
    expect(peakAbs(L, 0, at - 16)).toBeLessThan(1e-5);
    const late = peakAbs(L, Math.floor(SR * 1.2));
    expect(late).toBeLessThan(0.3);
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i])).toBe(true);
  });
});
