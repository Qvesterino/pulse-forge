/**
 * GROW (bassHarmonic) soak — 300 s flagship hardening (AGENTS gate parity
 * with PRISM/VLYX/VØID/TWIST: heap growth ≤ 6 MB, drift ≤ 0.003 dB, zero
 * non-finite, zero subnormals).
 *
 * The generator runs a YIN tracker, PLL phase locks, glide refinement, a
 * deficit Goertzel pair, four envelope followers, a key envelope and 16
 * partial accumulators — all stateful one-poles and accumulators that a
 * long run can leave denormalized. Two soaks prove the invariants:
 *
 *  MOTION STRESS — the worst-case parameter surface (FOLD character, phase 1,
 *  presence 1, width 1, key PUMP, engine hint per note) over a repeating
 *  staccato bass pattern with a glide note: finite, no subnormals (output AND
 *  internal one-pole state), flat CPU, bounded heap, audible.
 *
 *  STATIC DRIFT — the same repeating pattern through a static worst-case
 *  patch (pure YIN, no key): the 10 s and the 280 s windows must match within
 *  0.003 dB. The pattern is strictly loop-periodic (every phase derives from
 *  LOOP time), so both windows are phase-aligned — the drift measurement is
 *  about the DSP, not about signal phase.
 *
 *  The soak also justifies the denormal flush added to `deficit2/3`,
 *  `envFast` and `envLag` in the same wave (their targets sit at 0 for
 *  minutes on rich input / silence).
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
interface GrowProcessor {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean;
  envFast: number;
  envLag: number;
  envLow: number;
  envGen: number;
  keyEnv: number;
  deficit2: number;
  deficit3: number;
  hpY: number[];
  hpX: number[];
}
let GrowProcessor: new () => GrowProcessor;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (
    name: string,
    cls: new () => unknown,
  ) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/bass-harmonic-processor.js");
  const cls = registered.get("bass-harmonic-processor");
  expect(cls, "bass-harmonic-processor self-registered").toBeDefined();
  GrowProcessor = cls as unknown as typeof GrowProcessor;
});

/** Worst-case parameter surface: FOLD + phase 1 + presence 1 + width 1 + key. */
function motionParameters(withKey: boolean): Record<string, Float32Array> {
  return {
    drive: new Float32Array([1]),
    focusHz: new Float32Array([90]),
    harmonics: new Float32Array([0.5]),
    subAnchor: new Float32Array([0.8]),
    lowCut: new Float32Array([45]),
    range: new Float32Array([4]),
    attack: new Float32Array([0.002]),
    release: new Float32Array([0.5]),
    sustain: new Float32Array([1]),
    retrig: new Float32Array([1]),
    character: new Float32Array([2]), // FOLD — the nonlinear stage
    phase: new Float32Array([1]),
    tilt: new Float32Array([0.5]),
    width: new Float32Array([1]),
    presence: new Float32Array([1]),
    keyMode: new Float32Array([withKey ? 1 : 0]),
    hintHz: new Float32Array([0]),
    mix: new Float32Array([1]),
    output: new Float32Array([0]),
  };
}

interface SoakMetrics {
  nonFinite: number;
  subNormalOutputs: number;
  subNormalInternals: number;
  peak: number;
  driftDb: number;
  earlyMedian: number;
  lateMedian: number;
  growthMb: number;
}

const NOTE_HZ = [55, 55, 73.42, 61.74];
const NOTE_LEN = 0.35;
const NOTE_GLIDE = 0.09; // the last note sweeps +9 % to exercise the refinement

function runSoak(parameters: Record<string, Float32Array>, withKey: boolean, withHint: boolean): SoakMetrics {
  const proc = new GrowProcessor();
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

  // Repeating 2 s staccato bass pattern (four notes, the last one gliding):
  // every phase derives from LOOP time, so the signal is strictly periodic —
  // identical in the 10 s and the 280 s windows.
  const noteAt = (loop: number): number => Math.min(3, Math.floor(loop / 0.5));
  const twoPi = 2 * Math.PI;
  const fill = (blockIndex: number) => {
    for (let i = 0; i < BLOCK; i++) {
      const loop = ((blockIndex * BLOCK + i) / SR) % 2;
      const k = noteAt(loop);
      const local = loop - k * 0.5;
      const base = NOTE_HZ[k]!;
      let v = 0;
      if (local < NOTE_LEN) {
        const glide = k === 3 ? NOTE_GLIDE : 0;
        const phase = twoPi * (base * local + (base * glide * local * local) / (2 * NOTE_LEN));
        const env = Math.min(1, local / 0.005) * Math.min(1, (NOTE_LEN - local) / 0.03);
        v = env * (0.5 * Math.sin(phase) + 0.18 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
      }
      inL[i] = v;
      inR[i] = v * 0.97;
      if (withKey) {
        const on = local < 0.08;
        keyL[i] = on ? 0.8 * Math.sin(twoPi * 60 * loop) : 0;
        keyR[i] = keyL[i];
      } else {
        keyL[i] = 0;
        keyR[i] = 0;
      }
    }
  };

  let nonFinite = 0;
  let subNormalOutputs = 0;
  let subNormalInternals = 0;
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

  const checkInternals = () => {
    const states = [
      proc.envFast,
      proc.envLag,
      proc.envLow,
      proc.envGen,
      proc.keyEnv,
      proc.deficit2,
      proc.deficit3,
      ...proc.hpY,
    ];
    for (const v of states) if (v !== 0 && (v < 0 || Math.abs(v) < 1e-20)) subNormalInternals++;
  };

  let heapStart = 0;
  if (typeof process !== "undefined" && process.memoryUsage) {
    global.gc?.();
    heapStart = process.memoryUsage().heapUsed;
  }

  for (let b = 0; b < TOTAL_BLOCKS; b++) {
    fill(b);
    if (withHint) {
      const loop = ((b * BLOCK) / SR) % 2;
      const k = noteAt(loop);
      const local = loop - k * 0.5;
      parameters.hintHz![0] = local < NOTE_LEN ? NOTE_HZ[k]! : 0;
    }
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
    if (b % (10 * BLOCKS_PER_SECOND) === 0) checkInternals();
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
    subNormalInternals,
    peak,
    driftDb,
    earlyMedian: median(early),
    lateMedian: median(late),
    growthMb,
  };
}

describe("GROW worklet soak (denormal / drift / determinism / allocation)", () => {
  it("300 s MOTION stress: finite, no subnormals, flat CPU, bounded heap", () => {
    const m = runSoak(motionParameters(true), true, true);
    console.log(
      `[grow-soak:motion] peak=${m.peak.toFixed(3)} earlyMedian=${m.earlyMedian.toFixed(4)}ms ` +
        `lateMedian=${m.lateMedian.toFixed(4)}ms subNormalOutputs=${m.subNormalOutputs} ` +
        `subNormalInternals=${m.subNormalInternals} heapGrowth=${m.growthMb.toFixed(1)}MB`,
    );
    expect(m.nonFinite).toBe(0);
    expect(m.peak).toBeGreaterThan(0.1);
    expect(m.peak).toBeLessThan(4);
    expect(m.subNormalOutputs).toBe(0);
    expect(m.subNormalInternals).toBe(0);
    expect(m.lateMedian).toBeLessThanOrEqual(Math.max(4 * m.earlyMedian, 0.05));
    expect(m.growthMb).toBeLessThanOrEqual(6);
  }, 900_000);

  it("300 s STATIC drift: the 10 s and 280 s windows match within 0.003 dB", () => {
    const m = runSoak(motionParameters(false), false, false);
    console.log(
      `[grow-soak:drift] drift=${m.driftDb.toFixed(5)}dB peak=${m.peak.toFixed(3)} ` +
        `subNormalOutputs=${m.subNormalOutputs} subNormalInternals=${m.subNormalInternals} ` +
        `heapGrowth=${m.growthMb.toFixed(1)}MB`,
    );
    expect(m.nonFinite).toBe(0);
    expect(m.subNormalOutputs).toBe(0);
    expect(m.subNormalInternals).toBe(0);
    expect(m.driftDb).toBeLessThanOrEqual(0.003);
    expect(m.growthMb).toBeLessThanOrEqual(6);
  }, 900_000);
});
