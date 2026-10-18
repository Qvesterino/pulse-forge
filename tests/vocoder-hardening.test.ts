/**
 * Vocoder hardening regressions (plugin audit round 5).
 *
 * Two confirmed defects in `src/audio-worklets/vocoder-processor.js`:
 *
 * 1. **Non-finite input poisoned every recursive state.** One NaN/Infinity
 *    block latched the 32 biquad y-states and both envelope followers; every
 *    later block rendered NaN forever (the graph boundary had no guard).
 * 2. **The SIBILANCE "high-pass" was not a high-pass.** The recurrence fed
 *    back the output without subtracting the previous low-pass input, so DC
 *    and 60 Hz passed at ~0.52 and the top octave was boosted. The intended
 *    chain (LP 4 kHz → HP 500 Hz) only exists with the direct form used by
 *    vinyl-processor.js: `hp = (1-c)·(hp + lp - lpPrev)`.
 *
 * Both are negative assertions: no non-finite sample survives, and content
 * BELOW the 500 Hz corner is rejected rather than merely "different".
 *
 * The processor runs as real code under the stubbed AudioWorkletGlobalScope
 * (same host pattern as tests/vocoder.test.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const SR = 48000;
const BLOCK = 128;

let factory: () => {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  rebuildLayout?: (...args: number[]) => void;
};

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  const source = readFileSync(
    resolve(import.meta.dirname ?? ".", "..", "src", "audio-worklets", "vocoder-processor.js"),
    "utf-8",
  );
  let captured: unknown = null;
  const host = new Function("registerProcessor", "AudioWorkletProcessor", "globalThis", source);
  host((_name: string, cls: unknown) => (captured = cls), FakeAudioWorkletProcessor, globalThis);
  if (!captured) throw new Error("no processor registered in vocoder-processor.js");
  factory = () => new (captured as new () => ReturnType<typeof factory>)();
});

const BASE = {
  bands: 16,
  loFreq: 120,
  hiFreq: 7000,
  q: 4,
  attack: 0.004,
  release: 0.06,
  shift: 0,
  sibilance: 1,
  stereo: 0,
  level: 0,
  mix: 1,
};

function param(patch: Record<string, number> = {}): Record<string, Float32Array> {
  return Object.fromEntries(Object.entries({ ...BASE, ...patch }).map(([k, v]) => [k, Float32Array.of(v)]));
}

function peak(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

function allFinite(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
  return true;
}

function sineBlocks(freq: number, amp: number, blocks: number, startSample = 0): [Float32Array, Float32Array] {
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * (startSample + i)) / SR);
    l[i] = v;
    r[i] = v;
  }
  return [l, r];
}

/** Render `blocks` quanta of the given modulator against a silent carrier and
 *  return the peak of the LAST block (the filters have long settled). */
function sibilanceTailPeak(freq: number | "dc", blocks: number, amp = 0.5): number {
  const proc = factory();
  const p = param({ sibilance: 1, mix: 1, level: 0 });
  let last = 0;
  for (let b = 0; b < blocks; b++) {
    const carrierL = new Float32Array(BLOCK);
    const carrierR = new Float32Array(BLOCK);
    const modL = new Float32Array(BLOCK);
    const modR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const v = freq === "dc" ? amp : amp * Math.sin((2 * Math.PI * freq * (b * BLOCK + i)) / SR);
      modL[i] = v;
      modR[i] = v;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[carrierL, carrierR], [modL, modR]], [[outL, outR]], p);
    if (b === blocks - 1) last = peak(outL);
  }
  return last;
}

describe("vocoder hardening — non-finite input cannot poison recursive state", () => {
  it("recovers after a NaN/Infinity block and stays finite for every later block", () => {
    const proc = factory();
    const p = param({ sibilance: 0.5 });
    const bad = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) bad[i] = i % 2 === 0 ? NaN : Infinity;
    const poisonOutL = new Float32Array(BLOCK);
    const poisonOutR = new Float32Array(BLOCK);
    proc.process(
      [
        [bad, bad],
        [bad, bad],
      ],
      [[poisonOutL, poisonOutR]],
      p,
    );

    let sawNonFinite = false;
    let tailPeak = 0;
    for (let b = 0; b < 32; b++) {
      const [car, carR] = sineBlocks(440, 0.4, 1, b * BLOCK);
      const [mod, modR] = sineBlocks(1000, 0.4, 1, b * BLOCK);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process([[car, carR], [mod, modR]], [[outL, outR]], p);
      if (!allFinite(outL) || !allFinite(outR)) sawNonFinite = true;
      if (b === 31) tailPeak = peak(outL);
    }
    expect(sawNonFinite, "no non-finite output after the poisoned block").toBe(false);
    expect(tailPeak, "the filterbank still processes after the poisoned block").toBeGreaterThan(0.01);
  });

  it("a short (undefined-read) input block is treated as silence, not NaN", () => {
    const proc = factory();
    const p = param({ sibilance: 0.5 });
    const short = new Float32Array(16); // shorter than the 128-sample output
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[short, short], [short, short]], [[outL, outR]], p);
    expect(allFinite(outL)).toBe(true);
    expect(allFinite(outR)).toBe(true);
  });
});

describe("vocoder hardening — SIBILANCE is the documented LP→HP chain", () => {
  it("rejects DC (a high-pass cannot pass a constant offset into the wet signal)", () => {
    // Pre-fix this settled at ~0.2065 (0.5 · 0.52 · 0.8): a constant offset.
    expect(sibilanceTailPeak("dc", 80)).toBeLessThan(1e-4);
  });

  it("attenuates 60 Hz below the 500 Hz corner instead of passing it at half level", () => {
    // Pre-fix: ~0.2065. Post-fix |H| = 60/√(60²+500²) ≈ 0.119 → ~0.034.
    expect(sibilanceTailPeak(60, 100)).toBeLessThan(0.08);
  });

  it("still passes the sibilance region and discriminates it from low content", () => {
    const low = sibilanceTailPeak(60, 100);
    const high = sibilanceTailPeak(2000, 100);
    expect(high).toBeGreaterThan(0.2);
    expect(high).toBeGreaterThan(low * 4);
  });

  it("does not boost near-Nyquist content above the 4 kHz low-pass response", () => {
    // Pre-fix the broken recurrence added ~+2.6 dB at 18 kHz (peak ≈ 0.148);
    // the LP→HP chain lands at ≈ 0.10.
    expect(sibilanceTailPeak(18000, 200)).toBeLessThan(0.12);
  });
});

describe("vocoder hardening — layout and parameter stability", () => {
  it("rebuilds the filterbank once for a layout and again only when it changes", () => {
    const proc = factory();
    let calls = 0;
    const original = proc.rebuildLayout!.bind(proc);
    proc.rebuildLayout = (...args: number[]) => {
      calls += 1;
      original(...args);
    };
    const carrierL = new Float32Array(BLOCK);
    const carrierR = new Float32Array(BLOCK);
    const modL = new Float32Array(BLOCK);
    const modR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      carrierL[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
      carrierR[i] = carrierL[i];
      modL[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR);
      modR[i] = modL[i];
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const run = (patch: Record<string, number>) => {
      const p = param(patch);
      for (let b = 0; b < 8; b++) proc.process([[carrierL, carrierR], [modL, modR]], [[outL, outR]], p);
    };
    run({});
    expect(calls, "same layout over eight blocks rebuilds once").toBe(1);
    run({ q: 8 });
    expect(calls, "a changed layout rebuilds once").toBe(2);
  });

  it("mono input mirrors to both output channels and stays finite", () => {
    const proc = factory();
    const p = param();
    const car = new Float32Array(BLOCK);
    const mod = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      car[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR);
      mod[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[car], [mod]], [[outL, outR]], p);
    expect(allFinite(outL)).toBe(true);
    expect(allFinite(outR)).toBe(true);
    for (let i = 0; i < BLOCK; i++) expect(outR[i]).toBeCloseTo(outL[i], 6);
  });

  it("full-scale alternating input at the extreme parameter corner stays finite and bounded", () => {
    const proc = factory();
    const p = param({ bands: 16, q: 16, shift: 24, sibilance: 1, level: 12, mix: 1, stereo: 1 });
    let worst = 0;
    for (let b = 0; b < 64; b++) {
      const l = new Float32Array(BLOCK);
      const r = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const v = (i + b) % 2 === 0 ? 1 : -1;
        l[i] = v;
        r[i] = -v;
      }
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process([[l, r], [l, r]], [[outL, outR]], p);
      expect(allFinite(outL) && allFinite(outR)).toBe(true);
      worst = Math.max(worst, peak(outL), peak(outR));
    }
    // Sonic clipping is allowed; unbounded divergence is not. Pre/post-fix both
    // sit far below this ceiling, so it fails only on a real runaway.
    expect(worst).toBeLessThan(50);
  });
});
