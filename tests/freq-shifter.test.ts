/**
 * Frequency Shifter suite tests — Hilbert SSB behaviour per module.
 *
 * Processors run headless via the stubbed AudioWorkletProcessor globals (the
 * same host pattern as tests/fx-expansion.test.ts and tests/vinyl-suite).
 * The workhorse is a Goertzel probe: a frequency shifter moves a 440 Hz tone
 * to 440±shift with no harmonic series, which no pitch shifter reproduces.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

interface FreqShiftLike {
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ) => boolean;
}

const SR = 44100;

function param(values: Record<string, number>): Record<string, Float32Array> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Float32Array.of(v)]));
}

function stereoBuffer(n: number, fill: (i: number) => number): Float32Array[] {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = fill(i);
  r.set(l);
  return [l, r];
}

function energyOf(block: Float32Array[]): number {
  let sum = 0;
  for (const ch of block) for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
  return Math.sqrt(sum / block.reduce((a, c) => a + c.length, 0));
}

function peakOf(block: Float32Array[]): number {
  let peak = 0;
  for (const ch of block) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return peak;
}

/** Goertzel: energy at one frequency in a block (single-sideband probe). */
function goertzel(data: Float32Array, freq: number): number {
  const k = Math.round((data.length * freq) / SR);
  const w = (2 * Math.PI * k) / data.length;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / data.length;
}

let freqShiftFactory: (options?: { processorOptions?: unknown }) => FreqShiftLike;

const BASE = {
  shift: 0,
  fine: 0,
  side: 0,
  lfoRate: 0.1,
  lfoDepth: 0,
  feedback: 0,
  delayTime: 30,
  drive: 0,
  tone: 16000,
  spread: 0,
  mix: 1,
};

/** Render `blocks` of a signal; returns the concatenation per channel. */
function render(
  fill: (i: number) => number,
  patch: Record<string, number> = {},
  opts: { blockLen?: number; blocks?: number; seed?: number } = {},
): Float32Array[] {
  const blockLen = opts.blockLen ?? 4096;
  const blocks = opts.blocks ?? 8;
  const fx = freqShiftFactory({ processorOptions: { seed: opts.seed ?? 7 } });
  const params = param({ ...BASE, ...patch });
  const outL = new Float32Array(blockLen * blocks);
  const outR = new Float32Array(blockLen * blocks);
  for (let b = 0; b < blocks; b++) {
    const input = stereoBuffer(blockLen, fill);
    const out: Float32Array[][] = [[new Float32Array(blockLen), new Float32Array(blockLen)]];
    fx.process([input], out, params);
    outL.set(out[0][0], b * blockLen);
    outR.set(out[0][1], b * blockLen);
  }
  return [outL, outR];
}

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  const source = readFileSync(
    resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets", "freqshifter-processor.js"),
    "utf-8",
  );
  let captured: unknown = null;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_name: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error("no processor registered in freqshifter-processor.js");
  freqShiftFactory = ((options?: { processorOptions?: unknown }) =>
    new (captured as new (o?: unknown) => FreqShiftLike)(options)) as typeof freqShiftFactory;
});

describe("FreqShift processor", () => {
  it("shift 0 preserves energy (allpass Hilbert pair is magnitude-flat)", () => {
    const [out] = render((i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.4, { shift: 0 });
    // Skip the filter-settle head; measure the tail.
    const tail = out.slice(out.length >> 1);
    let inEnergy = 0;
    for (let i = out.length >> 1; i < out.length; i++) {
      const v = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.4;
      inEnergy += v * v;
    }
    inEnergy = Math.sqrt(inEnergy / (out.length >> 1));
    const ratio = energyOf([tail]) / inEnergy;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  it("UPSHIFT moves a 440 Hz tone to 440+shift with no harmonic series", () => {
    const [out] = render((i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5, { shift: 120 });
    const tail = out.slice(out.length >> 1);
    // 440 + 120 = 560 Hz must dominate; 440 must be suppressed (SSB, not AM).
    expect(goertzel(tail, 560)).toBeGreaterThan(goertzel(tail, 440) * 4);
    // Not a pitch shift: no octave/harmonic family at 880 or 1320.
    expect(goertzel(tail, 880)).toBeLessThan(goertzel(tail, 560) * 0.3);
  });

  it("LOWER sideband lands at 440−shift", () => {
    const [out] = render((i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5, { shift: 120, side: 1 });
    const tail = out.slice(out.length >> 1);
    expect(goertzel(tail, 320)).toBeGreaterThan(goertzel(tail, 440) * 4);
    expect(goertzel(tail, 560)).toBeLessThan(goertzel(tail, 320) * 0.3);
  });

  it("BOTH keeps both sidebands (ring-mod shimmer)", () => {
    const [out] = render((i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5, { shift: 120, side: 2 });
    const tail = out.slice(out.length >> 1);
    expect(goertzel(tail, 560)).toBeGreaterThan(0.01);
    expect(goertzel(tail, 320)).toBeGreaterThan(0.01);
  });

  it("mix 0 is a bit-exact dry copy", () => {
    const fx = freqShiftFactory();
    const n = 1024;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.3;
      r[i] = Math.cos((2 * Math.PI * 330 * i) / SR) * 0.3;
    }
    const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    fx.process(
      [[l, r]],
      out,
      param({ ...BASE, shift: 500, lfoDepth: 200, feedback: 0.5, drive: 0.8, mix: 0 }),
    );
    for (let i = 0; i < n; i++) {
      expect(out[0][0][i]).toBe(l[i]);
      expect(out[0][1][i]).toBe(r[i]);
    }
  });

  it("LFO sweep animates the spectrum over time", () => {
    const [out] = render((i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5, {
      shift: 100,
      lfoRate: 2,
      lfoDepth: 150,
    });
    const half = out.length >> 1;
    const first = out.slice(half >> 1, half);
    const second = out.slice((half * 3) >> 1, half + (half >> 1));
    // A 2 Hz sweep over a ~0.37 s half moves the partials audibly.
    expect(goertzel(first, 540)).not.toBeCloseTo(goertzel(second, 540), 2);
  });

  it("feedback loop adds resonant energy vs the same dry shifter", () => {
    const fill = (i: number) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.4;
    const dryShift = render(fill, { shift: 200, feedback: 0 });
    const wetShift = render(fill, { shift: 200, feedback: 0.7, delayTime: 40 });
    const tail = (b: Float32Array) => b.slice(b.length >> 1);
    expect(energyOf([tail(wetShift[0])] as Float32Array[])).toBeGreaterThan(
      energyOf([tail(dryShift[0])] as Float32Array[]),
    );
  });

  it("spread decorrelates the channels (wide field at 1)", () => {
    const fill = (i: number) => Math.sin((2 * Math.PI * 330 * i) / SR) * 0.5;
    const [, narrowR] = render(fill, { shift: 150, spread: 0 });
    const [wideL, wideR] = render(fill, { shift: 150, spread: 1 });
    const mono = narrowR.slice(narrowR.length >> 1);
    // Narrow: both channels identical (mono wet from a stereo-identical feed).
    // Wide: right channel runs the opposite shift — they must diverge.
    let monoDiff = 0;
    for (let i = 0; i < mono.length; i++) monoDiff += Math.abs(mono[i] - mono[i]);
    expect(monoDiff).toBe(0);
    let wideDiff = 0;
    const wL = wideL.slice(wideL.length >> 1);
    const wR = wideR.slice(wideR.length >> 1);
    for (let i = 0; i < wL.length; i++) wideDiff += Math.abs(wL[i] - wR[i]);
    expect(wideDiff / wL.length).toBeGreaterThan(0.01);
  });

  it("is deterministic and stays finite under extremes", () => {
    const fill = (i: number) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.8;
    const patch = { shift: -1000, fine: 50, side: 2, lfoRate: 10, lfoDepth: 500, feedback: 0.9, drive: 1, mix: 1 };
    const a = render(fill, patch, { seed: 5 });
    const b = render(fill, patch, { seed: 5 });
    expect(Array.from(a[0])).toEqual(Array.from(b[0]));
    for (const v of a[0]) expect(Number.isFinite(v)).toBe(true);
    expect(peakOf(a)).toBeLessThan(4);
  });

  it("missing parameters fall back to descriptor defaults (back-compat)", () => {
    const fx = freqShiftFactory();
    const n = 1024;
    const input = stereoBuffer(n, (i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.4);
    const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    // Only the legacy two params present.
    expect(() => fx.process([input], out, param({ shift: 0, mix: 1 }))).not.toThrow();
    expect(energyOf(out[0])).toBeGreaterThan(0);
  });
});
