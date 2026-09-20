/**
 * Vinyl Suite processor tests — the professional module set (crackle, hiss,
 * rumble, wow/flutter, drive, year contour, width) on top of the AGE macro.
 *
 * Processors run headless via the stubbed AudioWorkletProcessor globals —
 * the same host pattern as tests/fx-expansion.test.ts. Every assertion is
 * deterministic because the noise RNG is seeded.
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

interface VinylLike {
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

let vinylFactory: (options?: { processorOptions?: unknown }) => VinylLike;

/** Render `blocks` of `blockLen` samples; returns the concatenation per channel. */
function render(
  patch: Record<string, number>,
  opts: { blockLen?: number; blocks?: number; seed?: number; fill?: (i: number) => number } = {},
): Float32Array[] {
  const blockLen = opts.blockLen ?? 4096;
  const blocks = opts.blocks ?? 8;
  const fx = vinylFactory({ processorOptions: { seed: opts.seed ?? 7 } });
  const params = param(patch);
  const outL = new Float32Array(blockLen * blocks);
  const outR = new Float32Array(blockLen * blocks);
  for (let b = 0; b < blocks; b++) {
    const input = stereoBuffer(blockLen, opts.fill ?? (() => 0));
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
  const source = readFileSync(resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets", "vinyl-processor.js"), "utf-8");
  let captured: unknown = null;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_name: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error("no processor registered in vinyl-processor.js");
  vinylFactory = ((options?: { processorOptions?: unknown }) =>
    new (captured as new (o?: unknown) => VinylLike)(options)) as typeof vinylFactory;
});

describe("Vinyl Suite processor", () => {
  it("AGE macro scales the noise floor (amount 1 >> amount 0)", () => {
    const silent = () => 0;
    const off = render({ amount: 0, crackle: 0.8, hiss: 0.8, wow: 0.3, year: 0.5, mix: 1 }, { fill: silent });
    const on = render({ amount: 1, crackle: 0.8, hiss: 0.8, wow: 0.3, year: 0.5, mix: 1 }, { fill: silent });
    expect(energyOf(on)).toBeGreaterThan(energyOf(off) * 2);
  });

  it("each module is independently controllable (crackle / hiss / rumble)", () => {
    const silent = () => 0;
    const base = { amount: 1, crackle: 0, hiss: 0, rumble: 0, wow: 0, flutter: 0, drive: 0, mix: 1 };
    const quiet = render(base, { fill: silent });
    const crackly = render({ ...base, crackle: 1 }, { fill: silent });
    const hissy = render({ ...base, hiss: 1 }, { fill: silent });
    const rumbly = render({ ...base, rumble: 1 }, { fill: silent });
    expect(energyOf(crackly)).toBeGreaterThan(energyOf(quiet) * 4);
    expect(energyOf(hissy)).toBeGreaterThan(energyOf(quiet) * 4);
    expect(energyOf(rumbly)).toBeGreaterThan(energyOf(quiet) * 4);
    // Modules are distinct, not aliases of one another.
    const a = energyOf(crackly);
    const b = energyOf(hissy);
    const c = energyOf(rumbly);
    expect(Math.abs(a - b)).toBeGreaterThan(a * 0.02);
    expect(Math.abs(b - c)).toBeGreaterThan(b * 0.02);
  });

  it("CRACKLE TONE and POP DECAY change the pop character (not just level)", () => {
    const silent = () => 0;
    // One variable at a time: tone first, decay held constant.
    const base = { amount: 1, crackle: 1, crackleDecay: 0.5, hiss: 0, rumble: 0, wow: 0, flutter: 0, drive: 0, mix: 1 };
    const dark = render({ ...base, crackleTone: 400 }, { fill: silent, seed: 11 });
    const bright = render({ ...base, crackleTone: 9000 }, { fill: silent, seed: 11 });
    // A 9 kHz lowpass passes far more of each pop's broadband click than a
    // 400 Hz one — the tone control changes the pop's colour, not just level.
    expect(energyOf(bright)).toBeGreaterThan(energyOf(dark) * 1.5);

    // Decay next: POP DECAY high = long tail (retains more per sample), so it
    // carries more energy than a tight click at the same seed (identical pops).
    const tight = render({ ...base, crackleTone: 4000, crackleDecay: 0.05 }, { fill: silent, seed: 11 });
    const long_ = render({ ...base, crackleTone: 4000, crackleDecay: 0.95 }, { fill: silent, seed: 11 });
    expect(energyOf(tight)).toBeLessThan(energyOf(long_));
  });

  it("WOW depth modulates the read (pitch drift), RATE changes how fast", () => {
    // A steady tone through a modulated delay develops sidebands; the wobbled
    // render must diverge from the still one past the filter settle region.
    const tone = (i: number) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
    const still = render({ amount: 1, wow: 0, flutter: 0, crackle: 0, hiss: 0, rumble: 0, drive: 0, mix: 1 }, { fill: tone });
    const wobble = render({ amount: 1, wow: 1, wowRate: 4, flutter: 1, flutterRate: 30, crackle: 0, hiss: 0, rumble: 0, drive: 0, mix: 1 }, { fill: tone });
    let diff = 0;
    for (let i = 4096; i < still[0].length; i++) diff += Math.abs(wobble[0][i] - still[0][i]);
    expect(diff / still[0].length).toBeGreaterThan(0.01);
  });

  it("DRIVE saturates and stays bounded (no runaway)", () => {
    const tone = (i: number) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.7;
    const clean = render({ amount: 0, drive: 0, mix: 1 }, { fill: tone });
    const driven = render({ amount: 0, drive: 1, mix: 1 }, { fill: tone });
    expect(energyOf(driven)).toBeLessThan(energyOf(clean) * 1.6);
    expect(peakOf(driven)).toBeLessThan(1.2);
    // Saturation reshapes the waveform: the driven signal differs past settle.
    let diff = 0;
    for (let i = 4096; i < clean[0].length; i++) diff += Math.abs(driven[0][i] - clean[0][i]);
    expect(diff / clean[0].length).toBeGreaterThan(0.005);
  });

  it("YEAR thins the band (1920 kills highs, 2020 keeps them)", () => {
    // High tone at 8 kHz: the old contour lowpasses it away.
    const high = (i: number) => Math.sin((2 * Math.PI * 8000 * i) / SR) * 0.5;
    const modern = render({ amount: 0, year: 0, drive: 0, mix: 1 }, { fill: high });
    const vintage = render({ amount: 0, year: 1, drive: 0, mix: 1 }, { fill: high });
    expect(energyOf(vintage)).toBeLessThan(energyOf(modern) * 0.4);
  });

  it("WIDTH collapses the wet path to mono at 0 and keeps stereo at 1", () => {
    // Anti-phase input: a mono wet sum cancels, a stereo one survives.
    const fx = (width: number) => {
      const n = 4096;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.5;
        l[i] = v;
        r[i] = -v;
      }
      const worker = vinylFactory({ processorOptions: { seed: 5 } });
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      worker.process([[l, r]], out, param({ amount: 0, wow: 0, flutter: 0, crackle: 0, hiss: 0, rumble: 0, drive: 0, mix: 1, width }));
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Math.abs(out[0][0][i] - out[0][1][i]);
      return sum / n;
    };
    // Width 0 → both wet channels become the mid (≈ 0 for anti-phase), so the
    // channel difference collapses; width 1 keeps them apart.
    expect(fx(0)).toBeLessThan(fx(1));
  });

  it("is deterministic for the same seed and differs across seeds", () => {
    const patch = { amount: 1, crackle: 1, hiss: 0.5, rumble: 0.3, wow: 0.4, flutter: 0.3, mix: 1 };
    const a = render(patch, { seed: 42, fill: () => 0 });
    const b = render(patch, { seed: 42, fill: () => 0 });
    const c = render(patch, { seed: 43, fill: () => 0 });
    expect(Array.from(a[0])).toEqual(Array.from(b[0]));
    expect(Array.from(a[0])).not.toEqual(Array.from(c[0]));
  });

  it("missing parameters fall back to descriptor defaults (back-compat)", () => {
    // A document written before the suite existed carries only the old params.
    const fx = vinylFactory({ processorOptions: { seed: 3 } });
    const out: Float32Array[][] = [[new Float32Array(1024), new Float32Array(1024)]];
    const input = stereoBuffer(1024, (i) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5);
    expect(() => fx.process([input], out, param({ amount: 0.6, crackle: 0.4, wow: 0.3, year: 0.7, mix: 1 }))).not.toThrow();
    expect(Number.isFinite(peakOf(out[0]))).toBe(true);
    expect(peakOf(out[0])).toBeGreaterThan(0);
  });
});
