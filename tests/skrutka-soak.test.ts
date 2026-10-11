/**
 * TWIST soak (v2 hardening — ADR 0037 addendum).
 *
 * The all-pass engine has no feedback loop, but it runs 8 + 3 biquad sections
 * per channel under continuous parameter motion (envelope-driven radius, key
 * envelopes, LFO focus sweeps). This soak proves the invariants that only
 * appear over time:
 *
 *  1. Every output sample of the 120 s render is finite.
 *  2. The burst is audible (the effect actually processes).
 *  3. No subnormal output samples anywhere (the state flush guard holds).
 *  4. CPU flatness: silent-phase blocks are not slower than signal-phase
 *     blocks — a denormal trap would make "silence" the expensive regime.
 *  5. Heap growth over the whole soak stays bounded (no per-block allocation).
 */
import { beforeAll, describe, expect, it } from "vitest";

const SR = 44100;
const BLOCK = 128;
const BLOCKS_PER_SECOND = SR / BLOCK;
const BURST_SECONDS = 60;
const TOTAL_SECONDS = 120;
const TOTAL_BLOCKS = TOTAL_SECONDS * BLOCKS_PER_SECOND;

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage(): void {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => unknown>();
let SkrutkaProcessor: new () => {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
};

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (
    name: string,
    cls: new () => unknown,
  ) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/skrutka-processor.js");
  const cls = registered.get("skrutka-processor");
  expect(cls, "skrutka-processor self-registered").toBeDefined();
  SkrutkaProcessor = cls as unknown as typeof SkrutkaProcessor;
});

/** Worst-case parameter surface: full cascade + dynamic + key + LFO motion. */
function soakParameters(): Record<string, Float32Array> {
  return {
    dispersion: new Float32Array([1]),
    punch: new Float32Array([1]),
    punchHz: new Float32Array([0]),
    punchMix: new Float32Array([1]),
    focusHz: new Float32Array([220]),
    shape: new Float32Array([1]),
    spread: new Float32Array([1]),
    dyn: new Float32Array([1]),
    keyMode: new Float32Array([1]),
    lfoHz: new Float32Array([8]),
    lfoShape: new Float32Array([2]),
    lfoDepth: new Float32Array([1]),
    lfoPhase: new Float32Array([-1]),
    mix: new Float32Array([1]),
    output: new Float32Array([0]),
  };
}

describe("skrutka worklet soak (denormal / determinism / allocation)", () => {
  it("120 s render: finite, no subnormals, flat CPU through silence, bounded heap", () => {
    const proc = new SkrutkaProcessor();
    const parameters = soakParameters();
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    const keyL = new Float32Array(BLOCK);
    const keyR = new Float32Array(BLOCK);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inputs: Float32Array[][] = [
      [inL, inR],
      [keyL, keyR],
    ];
    const outputs: Float32Array[][] = [[outL, outR]];

    const burstBlocks = BURST_SECONDS * BLOCKS_PER_SECOND;
    const fill = (blockIndex: number, silent: boolean) => {
      if (silent) {
        inL.fill(0);
        inR.fill(0);
        keyL.fill(0);
        keyR.fill(0);
        return;
      }
      for (let i = 0; i < BLOCK; i++) {
        const t = (blockIndex * BLOCK + i) / SR;
        const env = t < 0.5 ? 1 : Math.exp((-3 * (t - 0.5)) / 1);
        const v = 0.45 * env * Math.sin(2 * Math.PI * 110 * t);
        inL[i] = v;
        inR[i] = v;
        // Rhythmic key (kick-like) so PUMP and the envelope followers move.
        const phase = (blockIndex * BLOCK + i) / SR;
        const on = phase % 0.5 < 0.08;
        keyL[i] = on ? 0.8 * Math.sin(2 * Math.PI * 60 * t) : 0;
        keyR[i] = keyL[i];
      }
    };

    let nonFinite = 0;
    let subNormalOutputs = 0;
    let burstPeak = 0;
    let silentPeak = 0;
    const blockTimes: number[] = [];

    let heapStart = 0;
    if (typeof process !== "undefined" && process.memoryUsage) {
      global.gc?.();
      heapStart = process.memoryUsage().heapUsed;
    }

    for (let b = 0; b < TOTAL_BLOCKS; b++) {
      const silent = b >= burstBlocks;
      fill(b, silent);

      const t0 = performance.now();
      proc.process(inputs, outputs, parameters);
      const dt = performance.now() - t0;
      blockTimes.push(dt);

      for (let i = 0; i < BLOCK; i++) {
        const l = outL[i]!;
        const r = outR[i]!;
        if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
        const a = Math.max(Math.abs(l), Math.abs(r));
        if (b < burstBlocks && a > burstPeak) burstPeak = a;
        if (b >= burstBlocks && a > silentPeak) silentPeak = a;
        const m = Math.min(Math.abs(l), Math.abs(r));
        if (m > 0 && m < 1e-20) subNormalOutputs++;
      }
    }

    const median = (arr: number[]) => {
      const sorted = [...arr].sort((x, y) => x - y);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    const early = blockTimes.slice(200, 700);
    const late = blockTimes.slice(TOTAL_BLOCKS - 10 * BLOCKS_PER_SECOND);
    const earlyMedian = median(early);
    const lateMedian = median(late);

    let growthMb = 0;
    if (typeof process !== "undefined" && process.memoryUsage) {
      global.gc?.();
      growthMb = (process.memoryUsage().heapUsed - heapStart) / (1024 * 1024);
    }

    console.log(
      `[skrutka-soak] burstPeak=${burstPeak.toFixed(3)} silentPeak=${silentPeak.toExponential(2)} ` +
        `earlyMedian=${earlyMedian.toFixed(4)}ms lateMedian=${lateMedian.toFixed(4)}ms ` +
        `subNormalOutputs=${subNormalOutputs} heapGrowth=${growthMb.toFixed(1)}MB`,
    );

    expect(nonFinite).toBe(0);
    expect(burstPeak).toBeGreaterThan(0.1);
    expect(subNormalOutputs).toBe(0);
    expect(lateMedian).toBeLessThanOrEqual(Math.max(4 * earlyMedian, 0.02));
    expect(growthMb).toBeLessThanOrEqual(6);
  }, 180_000);
});
