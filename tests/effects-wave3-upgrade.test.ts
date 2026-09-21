/**
 * Wave-3 effect upgrade tests — the "vône" round:
 *
 *   reverb  — true stereo-in (L/R tails decorrelate) + MOD drift
 *   comb    — SPREAD separates the L/R notches (stereo resonator)
 *   registry— reverb MOD, comb SPREAD, phaser CENTER/SPREAD contracts
 *
 * (Phaser center/spread live in the registry factory — native nodes, so
 * only the param contract is testable without WebAudio; the reverb/comb
 * processors are probed directly like the wave-1 tests.)
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_DEFS, defaultParamsOf } from "../src/effects/registry";

const SR = 48000;
const BLOCK = 128;

class FakeAudioWorkletProcessor {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (_msg: unknown) => {},
  };
}

const registry = new Map<string, unknown>();

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: unknown) => {
    registry.set(name, cls);
  };
  // @ts-expect-error raw worklet processor files
  await import("../src/audio-worklets/reverb-processor.js");
  await import("../src/audio-worklets/comb-processor.js");
});

type Proc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};

function make(name: string): Proc {
  const Ctor = registry.get(name) as new () => Proc;
  if (!Ctor) throw new Error(`${name} did not register`);
  return new Ctor();
}

function runStereo(
  proc: Proc,
  params: Record<string, number>,
  gen: (i: number) => [number, number],
  seconds: number,
): [Float32Array, Float32Array] {
  const frames = Math.ceil(seconds * SR);
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  const blocks = Math.ceil(frames / BLOCK);
  for (let b = 0; b < blocks; b++) {
    const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    for (let i = 0; i < BLOCK; i++) {
      const [l, r] = gen(b * BLOCK + i);
      input[0][i] = l;
      input[1][i] = r;
    }
    const p: Record<string, Float32Array> = {};
    for (const [k, v] of Object.entries(params)) p[k] = new Float32Array([v]);
    proc.process([input], [output], p);
    for (let i = 0; i < BLOCK; i++) {
      const idx = b * BLOCK + i;
      if (idx < frames) {
        outL[idx] = output[0][i];
        outR[idx] = output[1][i];
      }
    }
  }
  return [outL, outR];
}

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

describe("reverb stereo-in + modulation", () => {
  let noiseState = 7;
  const gen = (): [number, number] => {
    noiseState = (1103515245 * noiseState + 12345) & 0x7fffffff;
    const v = 0.5 * (noiseState / 0x3fffffff - 1);
    return [v, -v]; // decorrelated stereo (anti-phase noise)
  };

  it("stereo-in: L-only and R-only impulses produce DECORRELATED tails", () => {
    const base = { decay: 1.5, damping: 8000, diffusion: 0.6, tone: 12000, mod: 0 };
    const tail = (side: 0 | 1): [Float32Array, Float32Array] => {
      const proc = make("reverb-processor");
      return runStereo(
        proc,
        base,
        (i) => (i === Math.floor(0.1 * SR) ? (side === 0 ? [0.8, 0] : [0, 0.8]) : [0, 0]),
        0.6,
      );
    };
    const [l0, r0] = tail(0);
    const [l1, r1] = tail(1);
    // Both tails have energy, and the channels DECORRELATE — the old
    // mono-sum version fed both networks identically and produced L/R tails
    // that matched sample-for-sample. Metric: normalized sample difference
    // (RMS can't see decorrelation — the envelopes stay near-identical).
    const sampleDiff = (a: Float32Array, b: Float32Array): number => {
      let diff = 0;
      let energy = 0;
      const from = Math.floor(0.2 * SR);
      for (let i = from; i < a.length; i++) {
        diff += Math.abs(a[i] - b[i]);
        energy += Math.abs(a[i]) + Math.abs(b[i]);
      }
      return diff / Math.max(energy, 1e-9);
    };
    const d0 = sampleDiff(l0, r0);
    const d1 = sampleDiff(l1, r1);
    expect(d0).toBeGreaterThan(0.3);
    expect(d1).toBeGreaterThan(0.3);
  });

  it("MOD drift changes the tail over time (no static metallic ring)", () => {
    const tail = (mod: number): [number, number] => {
      const proc = make("reverb-processor");
      const [l] = runStereo(proc, { decay: 2.5, damping: 8000, diffusion: 0.6, tone: 12000, mod }, gen, 1.2);
      return [rms(l, Math.floor(0.4 * SR), Math.floor(0.7 * SR)), rms(l, Math.floor(0.9 * SR))];
    };
    const [earlyOn, lateOn] = tail(0.8);
    const [earlyOff] = tail(0);
    // With modulation the two time windows diverge (the modes drift);
    // without it the tail is a static decay shape.
    const divergenceOn = Math.abs(earlyOn - lateOn) / Math.max(earlyOn, 1e-9);
    const divergenceOff = Math.abs(earlyOff - lateOn) / Math.max(earlyOff, 1e-9);
    expect(earlyOn).toBeGreaterThan(0.001);
    expect(divergenceOn).not.toBeCloseTo(divergenceOff, 3);
  });
});

describe("comb stereo spread", () => {
  it("spread=0 → identical channels; spread>0 → channels decorrelate", () => {
    const run = (spread: number): number => {
      let state = 4242;
      const proc = make("comb-processor");
      const [l, r] = runStereo(
        proc,
        { delayMs: 8, feedback: 0.6, damp: 9000, mix: 1, spread },
        () => {
          state = (1103515245 * state + 12345) & 0x7fffffff;
          const v = 0.6 * (state / 0x3fffffff - 1);
          return [v, v];
        },
        0.4,
      );
      // Sample-wise decorrelation (RMS can't see notch movement — both
      // channels' broadband energy stays nearly equal).
      let diff = 0;
      let energy = 0;
      const from = Math.floor(0.1 * SR);
      for (let i = from; i < l.length; i++) {
        diff += Math.abs(l[i] - r[i]);
        energy += Math.abs(l[i]) + Math.abs(r[i]);
      }
      return diff / Math.max(energy, 1e-9);
    };
    const monoDiff = run(0);
    const wideDiff = run(0.9);
    // spread 0: the comb is mono — L and R match sample-for-sample.
    expect(monoDiff).toBeLessThan(0.01);
    // spread 0.9: the R read runs 31 % deeper → the channels diverge.
    expect(wideDiff).toBeGreaterThan(0.1);
  });
});

describe("wave-3 registry contracts", () => {
  it("reverb exposes MOD", () => {
    const params = defaultParamsOf("reverb");
    expect(params["mod"]).toBe(0.35);
    expect(EFFECT_DEFS.reverb.params.some((p) => p.id === "mod")).toBe(true);
  });

  it("comb exposes SPREAD", () => {
    const params = defaultParamsOf("comb");
    expect(params["spread"]).toBe(0.25);
  });

  it("phaser exposes CENTER + SPREAD", () => {
    const params = defaultParamsOf("phaser");
    expect(params["center"]).toBe(800);
    expect(params["spread"]).toBe(0.5);
    const center = EFFECT_DEFS.phaser.params.find((p) => p.id === "center");
    expect(center?.taper).toBe("log");
  });
});
