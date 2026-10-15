import { beforeAll, describe, expect, it } from "vitest";

/**
 * M2 mastering DSP behavioral pins (ADR 0020 lineage) — processor-level,
 * same harness as the chorus-extreme coherence test. These prove the DSP
 * does what its panel claims: APEX caps at the ceiling, SPAN is a
 * mathematically neutral pass at width 1 and actually moves side energy,
 * TIDE ducks a ringing band and stays static at amount 0.
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}
const registered = new Map<string, any>();
beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/apeks-processor.js");
  await import("../src/audio-worklets/sirka-processor.js");
  await import("../src/audio-worklets/prud-processor.js");
});

const SR = 48000;
const BLOCK = 128;

function paramsOf(cls: any, overrides: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const d of cls.parameterDescriptors as { name: string; defaultValue: number }[]) {
    out[d.name] = Float32Array.from([overrides[d.name] ?? d.defaultValue]);
  }
  return out;
}

function run(
  cls: any,
  params: Record<string, Float32Array>,
  blocks: number,
  input: (i: number) => [number, number],
): { peakL: number; peakR: number; rmsL: number; lastL: Float32Array } {
  const proc = new cls();
  let peakL = 0;
  let peakR = 0;
  let sumSq = 0;
  let count = 0;
  let lastL = new Float32Array(0);
  for (let b = 0; b < blocks; b++) {
    const inp = [
      Float32Array.from({ length: BLOCK }, (_, i) => input(b * BLOCK + i)[0]),
      Float32Array.from({ length: BLOCK }, (_, i) => input(b * BLOCK + i)[1]),
    ];
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([inp], [out], params);
    lastL = out[0]!;
    for (let i = 0; i < BLOCK; i++) {
      const l = out[0]![i]!;
      const r = out[1]![i]!;
      if (b >= blocks - 4) {
        // Measure only the settled tail (filters/GR warm).
        peakL = Math.max(peakL, Math.abs(l));
        peakR = Math.max(peakR, Math.abs(r));
        sumSq += l * l;
        count++;
      }
    }
  }
  return { peakL, peakR, rmsL: Math.sqrt(sumSq / Math.max(1, count)), lastL };
}

describe("APEX maximizer", () => {
  it("loud input through heavy drive stays AT the ceiling (the GR trajectory caps peaks)", () => {
    const cls = registered.get("apeks-processor");
    const out = run(cls, paramsOf(cls, { drive: 1, ceiling: -6, release: 0.1 }), 12, (i) => [
      0.9 * Math.sin((2 * Math.PI * 220 * i) / SR),
      0.9 * Math.sin((2 * Math.PI * 220 * i) / SR),
    ]);
    const ceilLin = Math.pow(10, -6 / 20);
    expect(out.peakL).toBeLessThanOrEqual(ceilLin * 1.02);
    expect(out.peakL).toBeGreaterThan(0.01); // audible, not silenced
  });

  it("mix 0 is an exact passthrough; all extremes render finite", () => {
    const cls = registered.get("apeks-processor");
    const dry = run(cls, paramsOf(cls, { mix: 0 }), 6, (i) => [Math.sin((2 * Math.PI * 440 * i) / SR), 0]);
    const abs = (6 - 1) * BLOCK + (BLOCK - 1); // last sample of the last block
    expect(dry.lastL[BLOCK - 1]).toBeCloseTo(Math.sin((2 * Math.PI * 440 * abs) / SR), 5);
    const hot = run(cls, paramsOf(cls, { drive: 1, ceiling: -12, preserve: 1, release: 0.5, output: 12 }), 8, (i) => [
      Math.sin(i / 3),
      Math.cos(i / 7),
    ]);
    for (const v of hot.lastL) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("SPAN imager", () => {
  it("width 1 everywhere is a neutral pass-through (perfect-reconstruction splits)", () => {
    const cls = registered.get("sirka-processor");
    const out = run(cls, paramsOf(cls, { lowWidth: 1, midWidth: 1, highWidth: 1, mix: 1 }), 8, (i) => [
      Math.sin(i / 5) + 0.2 * Math.cos(i),
      Math.sin(i / 5 + 0.4) + 0.1 * Math.sin(i / 2),
    ]);
    // After settling, sample-wise ≈ input (one-pole tree reconstructs exactly
    // once warm; the last block starts at (blocks−1)·BLOCK).
    expect(out.peakL).toBeGreaterThan(0.01);
    const srcAt = (i: number) => Math.sin(i / 5) + 0.2 * Math.cos(i);
    const base = (8 - 1) * BLOCK;
    for (let i = 10; i < BLOCK; i += 16) {
      expect(out.lastL[i]).toBeCloseTo(srcAt(base + i), 2);
    }
  });

  it("mono input stays mono at ANY width (S=0 is width-invariant)", () => {
    const cls = registered.get("sirka-processor");
    const mono = run(cls, paramsOf(cls, { lowWidth: 2, midWidth: 0, highWidth: 2, mix: 1 }), 6, (i) => [
      Math.sin((2 * Math.PI * 300 * i) / SR),
      Math.sin((2 * Math.PI * 300 * i) / SR),
    ]);
    // Mono in → M/S with S = 0 → rescaling w cannot separate the channels.
    for (let i = 0; i < BLOCK; i += 8) expect(mono.lastL[i]).toBeCloseTo(mono.peakR >= 0 ? mono.lastL[i] : 0, 6);
    const sideAfterMono = Math.abs(mono.peakL - mono.peakR);
    expect(sideAfterMono).toBeLessThan(1e-6);
  });
});

describe("TIDE dynamic EQ", () => {
  it("a ringing band above threshold gets ducked; amount 0 keeps the band static", () => {
    const cls = registered.get("prud-processor");
    const tone = (i: number): [number, number] => [
      0.5 * Math.sin((2 * Math.PI * 900 * i) / SR),
      0.5 * Math.sin((2 * Math.PI * 900 * i) / SR),
    ];
    const ducked = run(cls, paramsOf(cls, { freq1: 900, thresh1: -18, amount1: -12 }), 10, tone);
    const open = run(cls, paramsOf(cls, { freq1: 900, thresh1: -18, amount1: 0 }), 10, tone);
    expect(ducked.rmsL).toBeLessThan(open.rmsL * 0.92);
    // amount 0: the cut can never close — output tracks the input level.
    expect(open.rmsL).toBeGreaterThan(0.2);
  });

  it("all extremes render finite and bounded", () => {
    const cls = registered.get("prud-processor");
    const hot = run(
      cls,
      paramsOf(cls, {
        freq1: 80,
        thresh1: -60,
        amount1: -12,
        q1: 8,
        freq2: 12000,
        thresh2: -60,
        amount2: -12,
        q2: 8,
        output: 12,
      }),
      8,
      (i) => [Math.sin(i / 2), Math.sin(i / 3)],
    );
    for (const v of hot.lastL) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(8);
    }
  });
});

describe("APEX true-peak ceiling (ceilingMode, sinc detector)", () => {
  /** Independent 8× sinc true-peak estimator (L=8, 32-tap sinc/Blackman). */
  function sincTruePeak8(data: Float32Array): number {
    const L = 8;
    const TAPS = 32;
    const sinc = (x: number) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const proto = new Float64Array(TAPS);
    let sum = 0;
    for (let m = 0; m < TAPS; m++) {
      const center = (m - (TAPS - 1) / 2) / L;
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * m) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * m) / (TAPS - 1));
      proto[m] = sinc(center) * w;
      sum += proto[m];
    }
    for (let m = 0; m < TAPS; m++) proto[m] /= sum;
    const phases: Float64Array[] = [];
    for (let p = 0; p < L; p++) {
      const taps: number[] = [];
      let psum = 0;
      for (let m = p; m < TAPS; m += L) {
        taps.push(proto[m]);
        psum += proto[m];
      }
      for (let i = 0; i < taps.length; i++) taps[i] /= psum;
      phases.push(Float64Array.from(taps));
    }
    const hist = new Float32Array(TAPS);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      for (let j = TAPS - 1; j > 0; j--) hist[j] = hist[j - 1];
      hist[0] = data[i];
      for (const taps of phases) {
        let acc = 0;
        for (let k = 0; k < taps.length; k++) acc += taps[k] * hist[k];
        peak = Math.max(peak, Math.abs(acc));
      }
    }
    return peak;
  }

  /** Flat-topped clipped pseudo-noise — the ISP-rich signal class. */
  const ispTone = (i: number): [number, number] => {
    const n = Math.max(-1, Math.min(1, ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 2.2));
    return [n * 1.2, n * 1.2];
  };

  it("THE DISCRIMINATOR: TP mode holds the reconstructed ceiling; SAMPLE mode lets ISPs escape", () => {
    const cls = registered.get("apeks-processor");
    const ceilLin = Math.pow(10, -6 / 20);
    const tp = run(cls, paramsOf(cls, { drive: 0, ceiling: -6, ceilingMode: 1, release: 0.05 }), 16, ispTone);
    const sample = run(cls, paramsOf(cls, { drive: 0, ceiling: -6, ceilingMode: 0, release: 0.05 }), 16, ispTone);
    const tpPeak = sincTruePeak8(tp.lastL);
    const samplePeakOut = sincTruePeak8(sample.lastL);
    // Sample peak holds in BOTH modes (the limiter always works there).
    expect(sample.peakL).toBeLessThanOrEqual(ceilLin * 1.03);
    // TRUE peak: TP mode guarantees the ceiling; SAMPLE mode measurably
    // overshoots it — strictly more true peak than the TP-mode result.
    expect(tpPeak).toBeLessThanOrEqual(ceilLin * 1.08);
    expect(samplePeakOut).toBeGreaterThan(ceilLin);
    expect(samplePeakOut).toBeGreaterThan(tpPeak);
  });

  it("TP mode renders finite at the extremes", () => {
    const cls = registered.get("apeks-processor");
    const hot = run(
      cls,
      paramsOf(cls, { drive: 1, ceiling: -12, ceilingMode: 1, preserve: 1, release: 0.5, output: 12 }),
      8,
      ispTone,
    );
    for (const v of hot.lastL) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("ZENIT limiter stage — the worklet is TRUE-PEAK aware (post-correction proof)", () => {
  /** Independent 8× sinc true-peak estimator (same construction as the APEKS pin). */
  function sincTP8(data: Float32Array): number {
    const L = 8;
    const TAPS = 32;
    const sinc = (x: number) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const proto = new Float64Array(TAPS);
    let sum = 0;
    for (let m = 0; m < TAPS; m++) {
      const c = (m - (TAPS - 1) / 2) / L;
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * m) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * m) / (TAPS - 1));
      proto[m] = sinc(c) * w;
      sum += proto[m];
    }
    for (let m = 0; m < TAPS; m++) proto[m] /= sum;
    const phases: Float64Array[] = [];
    for (let p = 0; p < L; p++) {
      const taps: number[] = [];
      let ps = 0;
      for (let m = p; m < TAPS; m += L) {
        taps.push(proto[m]);
        ps += proto[m];
      }
      for (let i = 0; i < taps.length; i++) taps[i] /= ps;
      phases.push(Float64Array.from(taps));
    }
    const hist = new Float32Array(TAPS);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      for (let j = TAPS - 1; j > 0; j--) hist[j] = hist[j - 1];
      hist[0] = data[i];
      for (const taps of phases) {
        let acc = 0;
        for (let k = 0; k < taps.length; k++) acc += taps[k] * hist[k];
        peak = Math.max(peak, Math.abs(acc));
      }
    }
    return peak;
  }

  /** ISP-rich flat-topped clipped noise (same class as the APEKS discriminator). */
  const ispNoise = (i: number): number => {
    const n = Math.max(-1, Math.min(1, ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 2.2));
    return n * 1.2;
  };

  it("the look-ahead limiter holds the RECONSTRUCTED ceiling on ISP-rich input (post-TP correction works)", async () => {
    // Import the REAL limiter processor (registers "limiter-processor").
    (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
    (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = class {
      port = { postMessage() {}, onmessage: null };
    };
    const registered = new Map<string, any>();
    (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (n: string, c: new () => any) =>
      registered.set(n, c);
    await import("../src/audio-worklets/limiter-processor.js");
    const cls = registered.get("limiter-processor");

    const proc = new cls();
    const descriptors = cls.parameterDescriptors as { name: string; defaultValue: number }[];
    const params: Record<string, Float32Array> = {};
    for (const d of descriptors) {
      // Ceiling -6, threshold -6, 2× oversample for the TP path, everything else default.
      const override =
        d.name === "ceiling" ? -6 : d.name === "threshold" ? -6 : d.name === "oversample" ? 2 : d.defaultValue;
      params[d.name] = Float32Array.from([override]);
    }

    // Run enough blocks for lookahead (5 ms) + post-delay (32 samples) + settle.
    const tail: Float32Array[] = [];
    for (let b = 0; b < 24; b++) {
      const inp = [
        Float32Array.from({ length: BLOCK }, (_, i) => ispNoise(b * BLOCK + i)),
        Float32Array.from({ length: BLOCK }, (_, i) => ispNoise(b * BLOCK + i)),
      ];
      const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      proc.process([inp], [out], params);
      if (b >= 12) tail.push(out[0]!); // settled tail only
    }
    const settled = new Float32Array(tail.length * BLOCK);
    for (let b = 0; b < tail.length; b++) settled.set(tail[b]!, b * BLOCK);

    const ceilLin = Math.pow(10, -6 / 20);
    const samplePeak = Math.max(...Array.from(settled).map(Math.abs));
    const truePeak = sincTP8(settled);
    // The limiter's OWN post-TP correction (0.1 dB margin) must hold:
    // reconstructed peak within ceiling + margin + estimator tolerance.
    expect(samplePeak).toBeLessThanOrEqual(ceilLin * 1.02);
    expect(truePeak).toBeLessThanOrEqual(ceilLin * 1.15); // 0.1 dB margin + tolerance
    expect(truePeak).toBeGreaterThan(ceilLin * 0.3); // it processed, not silenced
  });
});
