import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the RAW svfilter-processor.js (the exact script served to
 * AudioWorklet.addModule) inside Node: the file only needs
 * `registerProcessor` and an `AudioWorkletProcessor` base class.
 */
type Proc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, number[]>): boolean;
};

let Processor: new () => Proc;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 44100;
  const file = join(dirname(fileURLToPath(import.meta.url)), "../src/audio-worklets/svfilter-processor.js");
  const src = readFileSync(file, "utf8");
  let registered: (new () => Proc) | null = null;
  const registerProcessor = (_name: string, cls: new () => Proc) => {
    registered = cls;
  };
  class AudioWorkletProcessor {}
  new Function("registerProcessor", "AudioWorkletProcessor", src)(
    registerProcessor,
    AudioWorkletProcessor as unknown as object,
  );
  if (!registered) throw new Error("svfilter-processor did not register");
  Processor = registered;
});

function renderThrough(params: Record<string, number>, input: Float32Array): Float32Array {
  const proc = new Processor();
  const out = new Float32Array(input.length);
  proc.process([[input]], [[out]], {
    cutoff: [params.cutoff ?? 20000],
    resonance: [params.resonance ?? 0.1],
    mode: [params.mode ?? 0],
    drive: [params.drive ?? 0],
    mix: [params.mix ?? 1],
  });
  return out;
}

function peak(data: Float32Array): number {
  let v = 0;
  for (let i = 0; i < data.length; i++) v = Math.max(v, Math.abs(data[i]));
  return v;
}

/** Goertzel power at one exact bin. */
function goertzelPower(data: Float32Array, freq: number, sampleRate: number): number {
  const n = data.length;
  const k = Math.round((freq * n) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

describe("SVF drive (raw worklet DSP)", () => {
  const N = 32768;

  function sine(freq: number, amp = 0.8): Float32Array {
    const input = new Float32Array(N);
    for (let i = 0; i < N; i++) input[i] = amp * Math.sin((2 * Math.PI * freq * i) / 44100);
    return input;
  }

  it("drive 0 passes the filter deterministically and unchanged between runs", () => {
    const input = sine(8000, 0.5);
    const a = renderThrough({ drive: 0 }, input);
    const b = renderThrough({ drive: 0 }, input);
    expect(peak(a)).toBeGreaterThan(0.05);
    expect(a).toEqual(b);
  });

  it("drive saturates: bounded, deterministic, and clearly different from the clean path", () => {
    const input = sine(8000, 0.8);
    const clean = renderThrough({ drive: 0, cutoff: 12000 }, input);
    const driven = renderThrough({ drive: 0.9, cutoff: 12000 }, input);
    expect(peak(driven)).toBeGreaterThan(0.05);
    expect(peak(driven)).toBeLessThan(4.5); // bounded by the makeup gain
    let diff = 0;
    for (let i = 2048; i < N; i += 11) diff += Math.abs(clean[i] - driven[i]);
    expect(diff).toBeGreaterThan(1);
    const again = renderThrough({ drive: 0.9, cutoff: 12000 }, input);
    expect(driven).toEqual(again);
  });

  it("keeps folded harmonics ≥20dB under the fundamental at hard drive (2× oversampled)", () => {
    // 8 kHz tone driven hard: true odd harmonics land at 24k/40k/56k — all
    // ABOVE the output Nyquist (22.05k), so anything audible at their fold
    // points (20.1k/4.1k/11.9k) is aliasing. The 2× oversampled saturator
    // must keep those folds ≥20dB under the fundamental.
    const driven = renderThrough({ drive: 0.9, cutoff: 12000, resonance: 0.1 }, sine(8000, 0.8));
    const seg = driven.slice(4096);
    const f0 = goertzelPower(seg, 8000, 44100);
    const alias = goertzelPower(seg, 4100, 44100) + goertzelPower(seg, 11900, 44100);
    expect(f0).toBeGreaterThan(0);
    expect(alias).toBeLessThan(f0 * 0.01); // ≥20dB below the fundamental
  });
});
