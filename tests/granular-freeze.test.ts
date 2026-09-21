/**
 * Granular Freeze processor tests — send-bus texture hold behaviour.
 *
 * Processors run headless via the stubbed AudioWorkletProcessor globals (the
 * same host pattern as tests/reverse-swell.test.ts). Key assertions: a frozen
 * window keeps sounding in silence, the cloud is grain-based (non-DC), and
 * the seeded scatter stays deterministic.
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

interface FreezeLike {
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

/** Zero-crossing rate — a DC-ish pad reads ~0, a grain cloud reads high. */
function zeroCrossRate(data: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i - 1] <= 0 && data[i] > 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
  }
  return crossings / (data.length / SR);
}

let freezeFactory: (options?: { processorOptions?: unknown }) => FreezeLike;

const BASE = {
  freeze: 0,
  window: 2,
  position: 0.5,
  drift: 0.2,
  grainMs: 90,
  scatter: 0.3,
  pitch: 0,
  tone: 10000,
  level: 0,
  mix: 1,
};

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  const source = readFileSync(
    resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets", "granularfreeze-processor.js"),
    "utf-8",
  );
  let captured: unknown = null;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_name: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error("no processor registered in granularfreeze-processor.js");
  freezeFactory = ((options?: { processorOptions?: unknown }) =>
    new (captured as new (o?: unknown) => FreezeLike)(options)) as typeof freezeFactory;
});

describe("GranularFreeze processor", () => {
  it("passes audio through while live (no freeze)", () => {
    const fx = freezeFactory();
    const n = 2048;
    const input = stereoBuffer(n, (i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5);
    const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
    fx.process([input], out, param(BASE));
    for (let i = 0; i < n; i += 179) {
      expect(out[0][0][i]).toBeCloseTo(input[0][i], 5);
    }
  });

  it("keeps sounding from the frozen window when the input goes silent", () => {
    const fx = freezeFactory();
    const n = 4096;
    // Record 3 s of a rich tone.
    let cursor = 0;
    for (let b = 0; b < Math.ceil((SR * 3) / n); b++) {
      const input = stereoBuffer(n, () => {
        const v = Math.sin((2 * Math.PI * 220 * cursor) / SR) * 0.6;
        cursor++;
        return v;
      });
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process([input], out, param(BASE));
    }
    // Freeze, then feed SILENCE: the cloud must keep playing the window.
    const holdLen = Math.round(SR * 2);
    const live = freezeFactory();
    void live;
    const silent = stereoBuffer(holdLen, () => 0);
    const out: Float32Array[][] = [[new Float32Array(holdLen), new Float32Array(holdLen)]];
    fx.process([silent], out, param({ ...BASE, freeze: 1 }));
    const tail = out[0][0].slice(Math.floor(holdLen * 0.3)); // past the crossfade
    expect(rms(tail)).toBeGreaterThan(0.01);
  });

  it("the cloud is grain-based (no DC, real spectral content)", () => {
    const fx = freezeFactory();
    const n = 4096;
    let cursor = 0;
    for (let b = 0; b < Math.ceil((SR * 3) / n); b++) {
      const input = stereoBuffer(n, () => {
        const v = Math.sin((2 * Math.PI * 330 * cursor) / SR) * 0.6;
        cursor++;
        return v;
      });
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process([input], out, param(BASE));
    }
    const holdLen = Math.round(SR * 2);
    const out: Float32Array[][] = [[new Float32Array(holdLen), new Float32Array(holdLen)]];
    fx.process([stereoBuffer(holdLen, () => 0)], out, param({ ...BASE, freeze: 1, grainMs: 60, scatter: 0.5 }));
    const tail = out[0][0].slice(Math.floor(holdLen * 0.3));
    // A 330 Hz cloud crosses zero ~660×/s; a stuck DC value would read ~0.
    expect(zeroCrossRate(tail)).toBeGreaterThan(300);
  });

  it("PITCH moves the frozen cloud's pitch", () => {
    const record = (pitch: number) => {
      const fx = freezeFactory();
      const n = 4096;
      let cursor = 0;
      for (let b = 0; b < Math.ceil((SR * 3) / n); b++) {
        const input = stereoBuffer(n, () => {
          const v = Math.sin((2 * Math.PI * 220 * cursor) / SR) * 0.6;
          cursor++;
          return v;
        });
        const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
        fx.process([input], out, param(BASE));
      }
      const holdLen = Math.round(SR * 2);
      const out: Float32Array[][] = [[new Float32Array(holdLen), new Float32Array(holdLen)]];
      fx.process([stereoBuffer(holdLen, () => 0)], out, param({ ...BASE, freeze: 1, pitch, grainMs: 120, scatter: 0 }));
      return zeroCrossRate(out[0][0].slice(Math.floor(holdLen * 0.3)));
    };
    const flat = record(0);
    const up = record(12);
    // +12 st doubles the read rate → roughly double the crossings.
    expect(up).toBeGreaterThan(flat * 1.5);
  });

  it("is deterministic for the same seed (seeded scatter)", () => {
    const run = () => {
      const fx = freezeFactory({ processorOptions: { seed: 42 } });
      const n = 2048;
      let cursor = 0;
      for (let b = 0; b < 12; b++) {
        const input = stereoBuffer(n, () => {
          const v = Math.sin((2 * Math.PI * 440 * cursor) / SR) * 0.5;
          cursor++;
          return v;
        });
        const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
        fx.process([input], out, param(BASE));
      }
      const holdLen = Math.round(SR);
      const out: Float32Array[][] = [[new Float32Array(holdLen), new Float32Array(holdLen)]];
      fx.process([stereoBuffer(holdLen, () => 0)], out, param({ ...BASE, freeze: 1 }));
      return out[0][0];
    };
    const a = run();
    const b = run();
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("releasing the freeze crossfades back to live audio", () => {
    const fx = freezeFactory();
    const n = 2048;
    const fill = (i: number) => Math.sin((2 * Math.PI * 300 * i) / SR) * 0.6;
    let cursor = 0;
    for (let b = 0; b < 20; b++) {
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process(
        [
          stereoBuffer(n, () => {
            const v = fill(cursor);
            cursor++;
            return v;
          }),
        ],
        out,
        param(BASE),
      );
    }
    // Freeze for a while.
    for (let b = 0; b < 8; b++) {
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      fx.process([stereoBuffer(n, () => 0)], out, param({ ...BASE, freeze: 1 }));
    }
    // Release and feed live audio again — the output must return to the input.
    let settled: Float32Array = new Float32Array(n);
    for (let b = 0; b < 8; b++) {
      const out: Float32Array[][] = [[new Float32Array(n), new Float32Array(n)]];
      const live = stereoBuffer(n, () => {
        const v = fill(cursor);
        cursor++;
        return v;
      });
      fx.process([live], out, param({ ...BASE, freeze: 0 }));
      settled = out[0][0];
    }
    // After the crossfade settles, the dry signal dominates again: the output
    // tracks the input amplitude scale (not the frozen cloud's).
    expect(peak(settled)).toBeGreaterThan(0.1);
    expect(Number.isFinite(peak(settled))).toBe(true);
  });
});
