import { beforeAll, describe, expect, it } from "vitest";
import { truePeakOversampled } from "../src/audio-engine/metering";
import { LIMITER_OUTPUT_TRUEPEAK_CORRECTION_SAMPLES } from "../src/audio-worklets/limiter-node";

/**
 * Aliasing + true-peak battery:
 *
 *  - Core limiter (`limiter-processor.js`): the ITU-R four-phase true-peak
 *    detector catches ceiling-exceeding INTERSAMPLE peaks a sample-peak
 *    detector cannot see (fs/4 sine isolation test), while ordinary sines
 *    behave exactly like the legacy detector (regression pin), latency follows
 *    the Float32 AudioParam sample grid used by PDC, mix = 0 is unity, and
 *    extremes stay finite + bounded.
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
  sampleRate = SR,
): { L: Float32Array; R: Float32Array } {
  const nBlocks = Math.ceil((seconds * sampleRate) / BLOCK);
  const L = new Float32Array(nBlocks * BLOCK);
  const R = new Float32Array(nBlocks * BLOCK);
  for (let b = 0; b < nBlocks; b++) {
    // Advance the stubbed worklet clock — the limiter's ~20 Hz GR meter
    // posts against currentTime like the real AudioWorkletGlobalScope.
    fakeNow += BLOCK / sampleRate;
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
  const legacyLink = values.link ?? 1;
  for (const n of names) {
    const fallback = n === "transientLink" || n === "releaseLink" ? legacyLink : n === "link" ? 1 : 0;
    out[n] = Float32Array.from([values[n] ?? fallback]);
  }
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

function rmsBetween(buf: Float32Array, from: number, to: number): number {
  let sumSquares = 0;
  for (let i = from; i < to; i++) sumSquares += buf[i]! * buf[i]!;
  return Math.sqrt(sumSquares / Math.max(1, to - from));
}

const LIM = ["threshold", "ceiling", "release", "lookahead", "link", "transientLink", "releaseLink", "mix"];

describe("limiter true-peak detector", () => {
  it("matches the ITU-R report estimator, including sampled peaks", () => {
    const input = Float32Array.from({ length: 4096 }, (_, n) => {
      const high = 0.67 * Math.sin(2 * Math.PI * 0.47 * n + Math.PI / 7);
      const low = 0.22 * Math.sin(2 * Math.PI * 0.071 * n + 0.3);
      return high + low;
    });
    const proc = new (registered.get("limiter-processor")!)();
    let position = 0;
    let workletPeak = 0;
    for (const sample of input) {
      position = proc.truePeakStep(proc.histL, position, sample);
      workletPeak = Math.max(workletPeak, proc.tpOut);
    }

    expect(workletPeak).toBeCloseTo(truePeakOversampled([input]), 6);
  });

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

  it("holds reconstructed output below the delivery ceiling with a small master reserve", () => {
    const ceilingDb = -1;
    const internalCeilingDb = ceilingDb - 0.2;
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, {
      threshold: internalCeilingDb - 3.2,
      ceiling: internalCeilingDb,
      release: 0.05,
      lookahead: 0.005,
      link: 1,
      mix: 1,
    });
    const { L, R } = renderStereo(proc, 1, prm, (n) => {
      const v = 1.2 * Math.sin((Math.PI / 2) * n + Math.PI / 4);
      return [v, v];
    });
    const from = Math.floor(SR * 0.5);
    const truePeak = truePeakOversampled([L.subarray(from), R.subarray(from)]);
    const truePeakDb = 20 * Math.log10(truePeak);

    expect(truePeakDb).toBeLessThanOrEqual(ceilingDb + 0.05);
  });

  it.each(["left", "right"] as const)("holds true peak when the independent transient is in the %s channel", (side) => {
    const deliveryCeilingDb = -1;
    const workletCeilingDb = deliveryCeilingDb - 0.2;
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, {
      threshold: workletCeilingDb - 3.2,
      ceiling: workletCeilingDb,
      release: 0.05,
      lookahead: 0.005,
      link: 1,
      mix: 1,
    });
    const { L, R } = renderStereo(proc, 0.4, prm, (n) => {
      const transient = 1.35 * Math.sin(2 * Math.PI * 0.47 * n + Math.PI / 5);
      const companion = 0.12 * Math.sin(2 * Math.PI * 0.17 * n + 0.3);
      return side === "left" ? [transient, companion] : [companion, transient];
    });

    const truePeak = truePeakOversampled([L, R]);
    const activeChannel = side === "left" ? L : R;
    const ceilingLin = Math.pow(10, deliveryCeilingDb / 20);
    expect(truePeak, `${side}-channel dBTP ${20 * Math.log10(truePeak)}`).toBeLessThanOrEqual(ceilingLin * 1.006);
    expect(peakAbs(activeChannel, Math.floor(SR * 0.2))).toBeGreaterThan(0.3);
  });

  it("preserves stereo ratio with linked transients and permits independent transient gain", () => {
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, {
      threshold: -6,
      ceiling: -1,
      release: 0.05,
      lookahead: 0.005,
      link: 1,
      transientLink: 1,
      releaseLink: 1,
      mix: 1,
    });
    const { L, R } = renderStereo(proc, 0.5, prm, (n) => {
      const left = 1.1 * Math.sin(2 * Math.PI * 0.47 * n + Math.PI / 5);
      const right = 0.25 * left;
      return [left, right];
    });
    const from = Math.round(0.1 * SR);
    let maxRatioError = 0;
    for (let i = from; i < L.length; i++) {
      maxRatioError = Math.max(maxRatioError, Math.abs(R[i]! - 0.25 * L[i]!));
    }

    expect(maxRatioError).toBeLessThan(1e-6);

    const unlinked = new (registered.get("limiter-processor")!)();
    const unlinkedParams = params(LIM, {
      threshold: -6,
      ceiling: -1,
      release: 0.05,
      lookahead: 0.005,
      link: 1,
      transientLink: 0,
      releaseLink: 1,
      mix: 1,
    });
    const independent = renderStereo(unlinked, 0.5, unlinkedParams, (n) => {
      const left = 1.1 * Math.sin(2 * Math.PI * 0.47 * n + Math.PI / 5);
      return [left, 0.25 * left];
    });
    let independentRatioError = 0;
    for (let i = from; i < independent.L.length; i++) {
      independentRatioError = Math.max(independentRatioError, Math.abs(independent.R[i]! - 0.25 * independent.L[i]!));
    }
    expect(independentRatioError).toBeGreaterThan(0.02);
    expect(truePeakOversampled([independent.L, independent.R])).toBeLessThanOrEqual(Math.pow(10, -1 / 20) * 1.006);
  });

  it("links channel gain recovery independently from transient gain reduction", () => {
    const render = (releaseLink: number) => {
      const proc = new (registered.get("limiter-processor")!)();
      const prm = params(LIM, {
        threshold: -7,
        ceiling: -1,
        release: 0.8,
        lookahead: 0.005,
        link: 1,
        transientLink: 0,
        releaseLink,
        mix: 1,
      });
      return renderStereo(proc, 0.5, prm, (n) => {
        const time = n / SR;
        const leftBurstTime = time - 0.04;
        const rightBurstTime = time - 0.12;
        const leftBurst =
          leftBurstTime >= 0 && leftBurstTime < 0.025 ? 1.7 * Math.sin(2 * Math.PI * 1300 * leftBurstTime) : 0;
        const rightBurst =
          rightBurstTime >= 0 && rightBurstTime < 0.22
            ? 1.65 * Math.exp(-rightBurstTime / 0.055) * Math.sin(2 * Math.PI * 1700 * rightBurstTime)
            : 0;
        const bed = 0.08 * Math.sin((2 * Math.PI * 180 * n) / SR);
        return [bed + leftBurst, bed + rightBurst];
      });
    };

    const independentRelease = render(0);
    const linkedRelease = render(1);
    const delaySamples = Math.round(Math.fround(0.005) * SR) + LIMITER_OUTPUT_TRUEPEAK_CORRECTION_SAMPLES;
    const from = delaySamples + Math.round(0.16 * SR);
    const to = delaySamples + Math.round(0.22 * SR);
    const independentRms = rmsBetween(independentRelease.L, from, to);
    const linkedRms = rmsBetween(linkedRelease.L, from, to);

    expect(independentRms).toBeGreaterThan(linkedRms * 1.01);
    const deliveryCeiling = Math.pow(10, -1 / 20) * 1.006;
    expect(truePeakOversampled([independentRelease.L, independentRelease.R])).toBeLessThanOrEqual(deliveryCeiling);
    expect(truePeakOversampled([linkedRelease.L, linkedRelease.R])).toBeLessThanOrEqual(deliveryCeiling);
  });

  it("keeps reconstructed output below the delivery ceiling for hostile spectra at supported master rates", () => {
    const workletGlobals = globalThis as typeof globalThis & { sampleRate: number };
    const originalSampleRate = workletGlobals.sampleRate;
    const deliveryCeilingDb = -1;
    // The output-side true-peak corrector should make a 0.2 dB working reserve
    // sufficient even when the main limiter's time-varying gain reconstructs
    // near-Nyquist material above its input-side ceiling.
    const workletCeilingDb = deliveryCeilingDb - 0.2;
    const ceilingLin = Math.pow(10, deliveryCeilingDb / 20);
    const scenarios = [
      {
        name: "near-Nyquist intersample tone",
        input: (n: number, _sr: number): [number, number] => {
          const phase = 2 * Math.PI * 0.47 * n + Math.PI / 7;
          return [1.45 * Math.sin(phase), 1.45 * Math.sin(phase + 0.19)];
        },
      },
      {
        name: "dense multitone",
        input: (n: number, sr: number): [number, number] => {
          const frequencies = [37, 173, 997, 3_007, 8_113, 0.43 * sr];
          let left = 0;
          let right = 0;
          for (let i = 0; i < frequencies.length; i++) {
            const phase = (2 * Math.PI * frequencies[i]! * n) / sr;
            const amplitude = i === frequencies.length - 1 ? 0.19 : 0.31;
            left += amplitude * Math.sin(phase + i * 0.61);
            right += amplitude * Math.sin(phase + i * 1.17 + 0.07);
          }
          return [left * 1.35, right * 1.35];
        },
      },
      {
        name: "alternating transient train",
        input: (n: number): [number, number] => {
          const phase = n % 113;
          const left = phase === 0 ? 2.4 : phase === 1 ? -1.6 : 0;
          const right = phase === 0 ? -1.9 : phase === 1 ? 2.1 : 0;
          return [left, right];
        },
      },
    ];

    try {
      for (const sampleRate of [44_100, 48_000, 96_000]) {
        workletGlobals.sampleRate = sampleRate;
        for (const scenario of scenarios) {
          const proc = new (registered.get("limiter-processor")!)();
          const prm = params(LIM, {
            threshold: workletCeilingDb - 3.2,
            ceiling: workletCeilingDb,
            release: 0.05,
            lookahead: 0.005,
            link: 1,
            mix: 1,
          });
          const { L, R } = renderStereo(proc, 0.3, prm, (n) => scenario.input(n, sampleRate), sampleRate);
          const truePeak = truePeakOversampled([L, R]);
          if (scenario.name === "near-Nyquist intersample tone") {
            expect(proc.postCorrectionGain, `${sampleRate} Hz output correction engages`).toBeLessThan(0.999);
          }
          expect(
            truePeak,
            `${scenario.name} at ${sampleRate} Hz: ${20 * Math.log10(truePeak)} dBTP`,
          ).toBeLessThanOrEqual(ceilingLin * 1.006);
        }
      }
    } finally {
      workletGlobals.sampleRate = originalSampleRate;
    }
  });

  it("latency includes lookahead plus output correction and mix = 0 stays unity", () => {
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, { threshold: -18, ceiling: -1, release: 0.05, lookahead: 0.005, link: 1, mix: 1 });
    const { L } = renderStereo(proc, 0.5, prm, (n) => (n === 0 ? [1, 1] : [0, 0]));
    const la = Math.round(0.005 * SR) + LIMITER_OUTPUT_TRUEPEAK_CORRECTION_SAMPLES;
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

  it("uses the same whole-sample lookahead at 44.1, 48 and 96 kHz", () => {
    const workletGlobals = globalThis as typeof globalThis & { sampleRate: number };
    const originalSampleRate = workletGlobals.sampleRate;
    try {
      for (const sampleRate of [44_100, 48_000, 96_000]) {
        workletGlobals.sampleRate = sampleRate;
        const proc = new (registered.get("limiter-processor")!)();
        const prm = params(LIM, {
          threshold: -18,
          ceiling: -1,
          release: 0.05,
          lookahead: 0.005,
          link: 1,
          mix: 1,
        });
        const { L } = renderStereo(proc, 0.02, prm, (n) => (n === 0 ? [1, 1] : [0, 0]), sampleRate);
        const delaySamples = Math.round(Math.fround(0.005) * sampleRate) + LIMITER_OUTPUT_TRUEPEAK_CORRECTION_SAMPLES;
        expect(delaySamples).toBe(
          (sampleRate === 44_100 ? 220 : sampleRate === 48_000 ? 240 : 480) +
            LIMITER_OUTPUT_TRUEPEAK_CORRECTION_SAMPLES,
        );
        expect(peakAbs(L, 0, delaySamples)).toBeLessThan(1e-6);
        expect(Math.abs(L[delaySamples]!)).toBeGreaterThan(0.5);
      }
    } finally {
      workletGlobals.sampleRate = originalSampleRate;
    }
  });

  it("uses the configured release for recovery after a limited burst", () => {
    const renderWithRelease = (release: number) => {
      const proc = new (registered.get("limiter-processor")!)();
      const prm = params(LIM, { threshold: -4.2, ceiling: -1.2, release, lookahead: 0.005, link: 1, mix: 1 });
      const { L } = renderStereo(proc, 2.8, prm, (n) => {
        const seconds = n / SR;
        const level = seconds < 0.25 ? 1.3 : 0.2;
        const sample = level * Math.sin((2 * Math.PI * 440 * n) / SR);
        return [sample, sample];
      });
      return L;
    };

    const delaySamples = Math.round(Math.fround(0.005) * SR) + LIMITER_OUTPUT_TRUEPEAK_CORRECTION_SAMPLES;
    const releaseStart = Math.round(0.25 * SR) + delaySamples;
    const earlyFrom = releaseStart + Math.round(0.04 * SR);
    const earlyTo = releaseStart + Math.round(0.09 * SR);
    const lateFrom = releaseStart + Math.round(2.2 * SR);
    const lateTo = releaseStart + Math.round(2.3 * SR);
    const fast = renderWithRelease(0.05);
    const slow = renderWithRelease(0.5);

    expect(rmsBetween(fast, earlyFrom, earlyTo)).toBeGreaterThan(rmsBetween(slow, earlyFrom, earlyTo) * 1.15);
    expect(Math.abs(rmsBetween(fast, lateFrom, lateTo) - rmsBetween(slow, lateFrom, lateTo))).toBeLessThan(
      rmsBetween(fast, lateFrom, lateTo) * 0.02,
    );
  });

  it("recovers between repeated transient bursts without accumulating gain reduction", () => {
    const periodSeconds = 0.75;
    const periodSamples = Math.round(periodSeconds * SR);
    const burstSamples = Math.round(0.008 * SR);
    const proc = new (registered.get("limiter-processor")!)();
    const prm = params(LIM, { threshold: -5, ceiling: -1, release: 0.12, lookahead: 0.005, link: 1, mix: 1 });
    const { L } = renderStereo(proc, 12, prm, (n) => {
      const bed = 0.12 * Math.sin((2 * Math.PI * 73 * n) / SR);
      const phase = n % periodSamples;
      const transient =
        phase < burstSamples ? 1.65 * Math.exp(-phase / (0.002 * SR)) * Math.sin((2 * Math.PI * 1300 * phase) / SR) : 0;
      const signal = bed + transient;
      return [signal, signal * 0.72];
    });

    const grMessages = (proc.port.messages as { type?: string; gr?: number }[]).filter(
      (message) => message?.type === "gr",
    );
    expect(Math.max(...grMessages.map((message) => message.gr ?? 0))).toBeGreaterThan(2);

    const delaySamples = Math.round(Math.fround(0.005) * SR) + LIMITER_OUTPUT_TRUEPEAK_CORRECTION_SAMPLES;
    const referenceBedRms = 0.12 / Math.SQRT2;
    const settledRms = Array.from({ length: 16 }, (_, beat) => {
      const start = delaySamples + Math.round((beat * periodSeconds + 0.52) * SR);
      const end = start + Math.round(0.08 * SR);
      return rmsBetween(L, start, end);
    });
    expect(Math.min(...settledRms)).toBeGreaterThan(referenceBedRms * 0.9);
    expect(Math.max(...settledRms) - Math.min(...settledRms)).toBeLessThan(referenceBedRms * 0.03);
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
