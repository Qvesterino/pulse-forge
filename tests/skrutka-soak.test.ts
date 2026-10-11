/**
 * TWIST (skrutka) soak — 300 s flagship hardening (AGENTS gate parity with
 * PRISM/VLYX/VØID: heap growth ≤ 6 MB, drift ≤ 0.003 dB, zero non-finite,
 * zero subnormals).
 *
 * The all-pass engine has no feedback loop, but it runs 8 + 3 biquad sections
 * per channel under continuous parameter motion (envelope-driven radius, key
 * envelopes, LFO focus sweeps, M/S field). Two soaks prove the invariants:
 *
 *  MOTION STRESS — the worst-case parameter surface (full cascade + dyn +
 *  key + random LFO + FIELD) over 300 s: finite, no subnormals, flat CPU,
 *  bounded heap, audible.
 *
 *  STATIC DRIFT — the same repeating musical pattern through a static
 *  worst-case patch: the 10 s and the 290 s windows must match within
 *  0.003 dB. (The motion soak cannot carry the drift gate because a random
 *  LFO is deliberately aperiodic — its determinism is pinned elsewhere.)
 */
import { beforeAll, describe, expect, it } from "vitest";

const SR = 44100;
const BLOCK = 128;
const BLOCKS_PER_SECOND = SR / BLOCK;
const TOTAL_SECONDS = 300;
const TOTAL_BLOCKS = TOTAL_SECONDS * BLOCKS_PER_SECOND;

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage(): void {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => unknown>();
let TwistProcessor: new () => {
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
  TwistProcessor = cls as unknown as typeof TwistProcessor;
});

/** Worst-case parameter surface: full cascade + dynamic + key + LFO + field. */
function motionParameters(): Record<string, Float32Array> {
  return {
    dispersion: new Float32Array([1]),
    punch: new Float32Array([1]),
    punchHz: new Float32Array([0]),
    punchMix: new Float32Array([1]),
    focusHz: new Float32Array([220]),
    shape: new Float32Array([1]),
    spread: new Float32Array([1]),
    field: new Float32Array([0.35]),
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

/** Static worst-case patch (no modulation): the drift-gate surface. */
function staticParameters(): Record<string, Float32Array> {
  const p = motionParameters();
  p.lfoDepth = new Float32Array([0]);
  p.dyn = new Float32Array([0]);
  p.keyMode = new Float32Array([0]);
  return p;
}

interface SoakMetrics {
  nonFinite: number;
  subNormalOutputs: number;
  peak: number;
  driftDb: number;
  earlyMedian: number;
  lateMedian: number;
  growthMb: number;
}

function runSoak(parameters: Record<string, Float32Array>): SoakMetrics {
  const proc = new TwistProcessor();
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const keyL = new Float32Array(BLOCK);
  const keyR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const inputs: Float32Array[][] = [[inL, inR], [keyL, keyR]];
  const outputs: Float32Array[][] = [[outL, outR]];

  // Repeating 2 s musical pattern (never silent): a kick-ish burst, a
  // sustained tone, key pulses on every half second. Every phase derives
  // from LOOP time (not absolute time) so the pattern is strictly periodic —
  // identical at the start and the end, which is what makes the drift
  // measurement honest.
  const fill = (blockIndex: number) => {
    for (let i = 0; i < BLOCK; i++) {
      const loop = ((blockIndex * BLOCK + i) / SR) % 2;
      const kickPhase = 2 * Math.PI * (55 * loop + (90 / 30) * (1 - Math.exp(-loop * 30)));
      const kick = loop < 0.25 ? Math.exp(-loop * 22) * Math.sin(kickPhase) : 0;
      const body = 0.22 * Math.sin(2 * Math.PI * 110 * loop);
      const v = 0.55 * kick + body;
      inL[i] = v;
      inR[i] = v * 0.97;
      const on = loop % 0.5 < 0.08;
      keyL[i] = on ? 0.8 * Math.sin(2 * Math.PI * 60 * loop) : 0;
      keyR[i] = keyL[i];
    }
  };

  let nonFinite = 0;
  let subNormalOutputs = 0;
  let peak = 0;
  const blockTimes: number[] = [];
  const rmsAccum = new Map<number, { sum: number; count: number }>();
  const addRms = (key: number, value: number) => {
    let win = rmsAccum.get(key);
    if (!win) {
      win = { sum: 0, count: 0 };
      rmsAccum.set(key, win);
    }
    win.sum += value;
    win.count++;
  };

  let heapStart = 0;
  if (typeof process !== "undefined" && process.memoryUsage) {
    global.gc?.();
    heapStart = process.memoryUsage().heapUsed;
  }

  for (let b = 0; b < TOTAL_BLOCKS; b++) {
    fill(b);
    const t0 = performance.now();
    proc.process(inputs, outputs, parameters);
    const dt = performance.now() - t0;
    blockTimes.push(dt);

    let blockSum = 0;
    for (let i = 0; i < BLOCK; i++) {
      const l = outL[i]!;
      const r = outR[i]!;
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      blockSum += l * l + r * r;
      const m = Math.min(Math.abs(l), Math.abs(r));
      if (m > 0 && m < 1e-20) subNormalOutputs++;
    }
    const tSec = b / BLOCKS_PER_SECOND;
    if (tSec >= 10 && tSec < 20) addRms(10, blockSum);
    if (tSec >= 280 && tSec < 290) addRms(280, blockSum);
  }

  const rmsAt = (key: number): number => {
    const win = rmsAccum.get(key)!;
    return Math.sqrt(win.sum / (win.count * BLOCK * 2));
  };
  const driftDb = Math.abs(20 * Math.log10(rmsAt(280) / rmsAt(10)));

  const median = (arr: number[]) => {
    const sorted = [...arr].sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const early = blockTimes.slice(200, 700);
  const late = blockTimes.slice(TOTAL_BLOCKS - 10 * BLOCKS_PER_SECOND);

  let growthMb = 0;
  if (typeof process !== "undefined" && process.memoryUsage) {
    global.gc?.();
    growthMb = (process.memoryUsage().heapUsed - heapStart) / (1024 * 1024);
  }

  return {
    nonFinite,
    subNormalOutputs,
    peak,
    driftDb,
    earlyMedian: median(early),
    lateMedian: median(late),
    growthMb,
  };
}

describe("TWIST worklet soak (denormal / drift / determinism / allocation)", () => {
  it("300 s MOTION stress: finite, no subnormals, flat CPU, bounded heap", () => {
    const m = runSoak(motionParameters());
    console.log(
      `[twist-soak:motion] peak=${m.peak.toFixed(3)} earlyMedian=${m.earlyMedian.toFixed(4)}ms ` +
        `lateMedian=${m.lateMedian.toFixed(4)}ms subNormalOutputs=${m.subNormalOutputs} ` +
        `heapGrowth=${m.growthMb.toFixed(1)}MB`,
    );
    expect(m.nonFinite).toBe(0);
    expect(m.peak).toBeGreaterThan(0.1);
    expect(m.subNormalOutputs).toBe(0);
    expect(m.lateMedian).toBeLessThanOrEqual(Math.max(4 * m.earlyMedian, 0.02));
    expect(m.growthMb).toBeLessThanOrEqual(6);
  }, 180_000);

  it("300 s STATIC drift: the 10 s and 290 s windows match within 0.003 dB", () => {
    const m = runSoak(staticParameters());
    console.log(
      `[twist-soak:drift] drift=${m.driftDb.toFixed(5)}dB peak=${m.peak.toFixed(3)} ` +
        `subNormalOutputs=${m.subNormalOutputs} heapGrowth=${m.growthMb.toFixed(1)}MB`,
    );
    expect(m.nonFinite).toBe(0);
    expect(m.subNormalOutputs).toBe(0);
    expect(m.driftDb).toBeLessThanOrEqual(0.003);
    expect(m.growthMb).toBeLessThanOrEqual(6);
  }, 180_000);
});
