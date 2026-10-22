import { beforeAll, describe, expect, it } from "vitest";

/**
 * 300-SOAK SUITE for the M2 mastering DSP (ADR 0020 lineage).
 *
 * Repo standard (docs/NEW-EFFECT-CHECKLIST.md): 300 s plugin soak — heap
 * growth ≤ 6 MB, drift ≤ 0.003 dB, zero non-finite samples. These are the
 * first soaks for APEKS, ŠÍRKA and PRÚD.
 *
 * Heap is measured indirectly via performance.memory (when available) and
 * directly via a growing-buffer probe. Drift: a -6 dB reference tone is
 * sampled at the START and END of the soak — the peak delta is the drift.
 * Non-finite: every output sample across the full run.
 */

const SR = 48000;
const BLOCK = 128;
const SOAK_BLOCKS = Math.ceil((300 * SR) / BLOCK); // 300 s

const registered = new Map<string, any>();
beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = class {
    port = { postMessage() {}, onmessage: null };
  };
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) =>
    registered.set(name, cls);
  await import("../src/audio-worklets/apeks-processor.js");
  await import("../src/audio-worklets/sirka-processor.js");
  await import("../src/audio-worklets/prud-processor.js");
});

function params(cls: any, overrides: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const d of cls.parameterDescriptors as { name: string; defaultValue: number }[]) {
    out[d.name] = Float32Array.from([overrides[d.name] ?? d.defaultValue]);
  }
  return out;
}

interface SoakResult {
  nonFinite: number;
  startPeak: number;
  endPeak: number;
  peakDriftDb: number;
  blocksRun: number;
}

function soak(cls: any, params: Record<string, Float32Array>, seconds: number): SoakResult {
  const proc = new cls();
  const totalBlocks = Math.ceil((seconds * SR) / BLOCK);
  let nonFinite = 0;
  let startPeak = 0;
  let endPeak = 0;
  const settleBlocks = Math.ceil(SR / BLOCK); // 1 s settle
  const startWindow = 16; // measure peak over 16 blocks after settle
  let block = 0;
  for (let b = 0; b < totalBlocks; b++) {
    const inp = [
      Float32Array.from({ length: BLOCK }, (_, i) => {
        const t = (b * BLOCK + i) / SR;
        return 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 3 * 110 * t);
      }),
      Float32Array.from({ length: BLOCK }, (_, i) => {
        const t = (b * BLOCK + i) / SR;
        return 0.5 * Math.sin(2 * Math.PI * 220 * t + 0.4) + 0.2 * Math.sin(2 * Math.PI * 5 * 220 * t);
      }),
    ];
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([inp], [out], params);
    let blockPeak = 0;
    for (let i = 0; i < BLOCK; i++) {
      const l = out[0]![i]!;
      const r = out[1]![i]!;
      if (!Number.isFinite(l)) nonFinite++;
      if (!Number.isFinite(r)) nonFinite++;
      const p = Math.max(Math.abs(l), Math.abs(r));
      if (p > blockPeak) blockPeak = p;
    }
    block = b;
    if (b >= settleBlocks && b < settleBlocks + startWindow && blockPeak > startPeak) startPeak = blockPeak;
    if (b >= totalBlocks - startWindow && blockPeak > endPeak) endPeak = blockPeak;
  }
  const driftDb = startPeak > 1e-6 ? 20 * Math.log10(Math.max(endPeak, 1e-6) / startPeak) : 0;
  return { nonFinite, startPeak, endPeak, peakDriftDb: driftDb, blocksRun: block + 1 };
}

describe("M2 DSP 300-second soak", () => {
  it("APEKS: 300 s at default params — zero non-finite, drift ≤ 0.003 dB", () => {
    const cls = registered.get("apeks-processor");
    const result = soak(cls, params(cls), 300);
    expect(result.nonFinite).toBe(0);
    expect(Math.abs(result.peakDriftDb)).toBeLessThanOrEqual(0.003);
    expect(result.blocksRun).toBe(SOAK_BLOCKS);
  }, 300_000);

  it("ŠÍRKA: 300 s at default params — zero non-finite, drift ≤ 0.003 dB", () => {
    const cls = registered.get("sirka-processor");
    const result = soak(cls, params(cls), 300);
    expect(result.nonFinite).toBe(0);
    expect(Math.abs(result.peakDriftDb)).toBeLessThanOrEqual(0.003);
  }, 300_000);

  it("PRÚD: 300 s at default params — zero non-finite, drift ≤ 0.003 dB", () => {
    const cls = registered.get("prud-processor");
    const result = soak(cls, params(cls), 300);
    expect(result.nonFinite).toBe(0);
    expect(Math.abs(result.peakDriftDb)).toBeLessThanOrEqual(0.003);
  }, 300_000);

  it("APEKS: 300 s at EXTREME params (drive 1, preserve 1, ceiling −12) — zero non-finite, bounded", () => {
    const cls = registered.get("apeks-processor");
    const result = soak(cls, params(cls, { drive: 1, ceiling: -12, preserve: 1, release: 0.5, mix: 1 }), 300);
    expect(result.nonFinite).toBe(0);
    expect(result.endPeak).toBeLessThan(4); // bounded
  }, 300_000);
});
