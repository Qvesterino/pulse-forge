/**
 * Reverse Swell processor tests — live reverse-envelope riser behaviour.
 *
 * Processors run headless via the stubbed AudioWorkletProcessor globals (the
 * same host pattern as tests/fx-expansion.test.ts and tests/vinyl-suite).
 * The key assertions: a trigger plays the recorded material BACKWARDS under
 * a RISING envelope, and the swell length follows `time`.
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

interface SwellLike {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
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

function rms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  return Math.sqrt(sum / Math.max(1, block.length));
}

function peak(block: Float32Array): number {
  let p = 0;
  for (let i = 0; i < block.length; i++) p = Math.max(p, Math.abs(block[i]));
  return p;
}

/** Goertzel: energy at one frequency in a block (spectral probe). */
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

let swellFactory: (options?: { processorOptions?: unknown }) => SwellLike;

const BASE = { engaged: 0, time: 2, reach: 2, curve: 0.6, tone: 12000, level: 0, mix: 1 };

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  const source = readFileSync(
    resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets", "reverseswell-processor.js"),
    "utf-8",
  );
  let captured: unknown = null;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_name: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error("no processor registered in reverseswell-processor.js");
  swellFactory = ((options?: { processorOptions?: unknown }) =>
    new (captured as new (o?: unknown) => SwellLike)(options)) as typeof swellFactory;
});

describe("ReverseSwell processor", () => {
  it("passes the dry signal through while idle (no trigger yet)", () => {
    const fx = swellFactory();
    const n = 2048;
    const input = stereoBuffer(n, (i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5);
    const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    fx.process([input], out, param(BASE));
    for (let i = 0; i < n; i += 173) {
      expect(out[0][0][i]).toBeCloseTo(input[0][i], 5);
    }
  });

  it("a trigger produces a RISING envelope over the swell", () => {
    const fx = swellFactory();
    const n = 4096;
    const fill = (i: number) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
    // Record 4 s of material — the swell reads `reach` seconds BACKWARDS from
    // the trigger, so the buffer must hold at least `reach` of history.
    let cursor = 0;
    for (let b = 0; b < Math.ceil((SR * 4) / n); b++) {
      const input = stereoBuffer(n, () => {
        const v = fill(cursor);
        cursor++;
        return v;
      });
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process([input], out, param(BASE));
    }
    // Silence during the swell → the output is the WET path alone, so the
    // measured envelope is the swell shape with no dry riding on top.
    const swellLen = Math.round(SR * 2);
    const silent = stereoBuffer(swellLen, () => 0);
    const out: Float32Array[][] = [[new Float32Array(swellLen), new Float32Array(swellLen)]];
    fx.process([silent], out, param({ ...BASE, engaged: 1, curve: 0 }));
    const tail = out[0][0];
    const q1 = peak(tail.slice(0, Math.floor(swellLen * 0.1)));
    const q2 = peak(tail.slice(Math.floor(swellLen * 0.3), Math.floor(swellLen * 0.4)));
    const q3 = peak(tail.slice(Math.floor(swellLen * 0.7), Math.floor(swellLen * 0.8)));
    // Linear envelope (curve 0): wet gain climbs monotonically 0 → 1.
    expect(q1).toBeLessThan(q2);
    expect(q2).toBeLessThan(q3);
    expect(q3).toBeGreaterThan(0.3);
  });

  it("plays the recorded material backwards (newest audio first)", () => {
    // Record 2 s of 200 Hz, then 2 s of 2000 Hz. A reverse read must play the
    // 2000 Hz section FIRST (it is the newest material at the trigger).
    const fx = swellFactory();
    const n = 4096;
    const blocksPerSection = Math.ceil((SR * 2) / n);
    let cursor = 0;
    for (let b = 0; b < blocksPerSection * 2; b++) {
      const freq = b < blocksPerSection ? 200 : 2000;
      const input = stereoBuffer(n, () => {
        const v = Math.sin((2 * Math.PI * freq * cursor) / SR) * 0.6;
        cursor++;
        return v;
      });
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process([input], out, param(BASE));
    }
    // Silence during the swell → the wet path alone is measured.
    const swellLen = Math.round(SR * 2);
    const out: Float32Array[][] = [[new Float32Array(swellLen), new Float32Array(swellLen)]];
    // reach 2 s reads the NEWEST 2 s — all 2000 Hz material.
    fx.process([stereoBuffer(swellLen, () => 0)], out, param({ ...BASE, engaged: 1, time: 2, reach: 2, curve: 0 }));
    const early = out[0][0].slice(Math.floor(swellLen * 0.2), Math.floor(swellLen * 0.4));
    expect(goertzel(early, 2000)).toBeGreaterThan(goertzel(early, 200) * 3);
  });

  it("swell length follows `time` (shorter time finishes sooner)", () => {
    const render = (time: number) => {
      const fx = swellFactory();
      const n = 2048;
      const fill = (i: number) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.6;
      let cursor = 0;
      for (let b = 0; b < Math.ceil((SR * 4) / n); b++) {
        const input = stereoBuffer(n, () => {
          const v = fill(cursor);
          cursor++;
          return v;
        });
        const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
        fx.process([input], out, param(BASE));
      }
      const swellLen = Math.round(SR * 4);
      const out: Float32Array[][] = [[new Float32Array(swellLen), new Float32Array(swellLen)]];
      fx.process([stereoBuffer(swellLen, () => 0)], out, param({ ...BASE, time, reach: 1, engaged: 1 }));
      // Wet energy in the 1–2 s window: a 1 s swell is already finished
      // there (silence), a 3 s swell is still rising.
      const from = Math.round(SR * 1.0);
      const to = Math.round(SR * 2.0);
      return rms(out[0][0].slice(from, to));
    };
    const shortSwell = render(1);
    const longSwell = render(3);
    expect(longSwell).toBeGreaterThan(shortSwell * 1.5);
  });

  it("is deterministic (no RNG) and stays finite under extremes", () => {
    const fill = (i: number) => Math.sin((2 * Math.PI * 220 * i) / SR) * 0.8;
    const run = () => {
      const fx = swellFactory();
      const n = 2048;
      for (let b = 0; b < 4; b++) {
        const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
        fx.process([stereoBuffer(n, fill)], out, param(BASE));
      }
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process(
        [stereoBuffer(n, fill)],
        out,
        param({ engaged: 1, time: 0.25, reach: 8, curve: 1, tone: 500, level: 12, mix: 1 }),
      );
      return out[0][0];
    };
    const a = run();
    const b = run();
    expect(Array.from(a)).toEqual(Array.from(b));
    for (const v of a) expect(Number.isFinite(v)).toBe(true);
  });

  it("re-triggering re-anchors the window (a second swell is audible again)", () => {
    const fx = swellFactory();
    const n = 2048;
    const fill = (i: number) => Math.sin((2 * Math.PI * 330 * i) / SR) * 0.6;
    for (let b = 0; b < 6; b++) {
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process([stereoBuffer(n, fill)], out, param(BASE));
    }
    // First swell.
    const out1: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    fx.process([stereoBuffer(n, fill)], out1, param({ ...BASE, engaged: 1, time: 0.25 }));
    // Release, then trigger again.
    const out2: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    fx.process([stereoBuffer(n, fill)], out2, param({ ...BASE, engaged: 0, time: 0.25 }));
    for (let b = 0; b < 4; b++) {
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process([stereoBuffer(n, fill)], out, param(BASE));
    }
    const out3: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    fx.process([stereoBuffer(n, fill)], out3, param({ ...BASE, engaged: 1, time: 0.25 }));
    // The second swell starts rising from near-zero again (fresh envelope).
    expect(peak(out3[0][0])).toBeGreaterThan(0);
    expect(peak(out3[0][0])).toBeLessThan(peak(out1[0][0]) * 3 + 0.5);
  });
});
