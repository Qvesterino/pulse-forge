import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_DEFS, WORKLET_EFFECTS, defaultParamsOf } from "../src/effects/registry";
import { EFFECT_META, clampEffectParam } from "../src/effects/definitions";
import type { EffectInstance } from "../src/project-model/types";

/**
 * KOREŇ (bassHarmonic) — behavioral pins.
 *
 * Processor-level (same harness as tests/m2-dsp.test.ts) plus factory-level
 * contract: honest 1:1 bypass when the lazy worklet module is not loaded, NaN
 * clamping, and the DSP claims the blurb makes:
 *   1. a 55 Hz sine gains measurable 2nd-harmonic energy (Goertzel at 110 Hz)
 *      when DRIVE is up — the missing-fundamental premise;
 *   2. DRIVE 0 generates nothing (2H stays at the dry level);
 *   3. SUB ANCHOR 0 removes the original fundamental from the wet path;
 *   4. LOW CUT high-passes the sub-anchor branch measurably;
 *   5. FOCUS limits tracking — fundamentals outside the window generate
 *      nothing (no invented harmonics);
 *   6. MIX 0 is a bit-exact dry passthrough.
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}
const registered = new Map<string, any>();
beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/bass-harmonic-processor.js");
  await import("../src/audio-worklets/tape-processor.js");
});

const SR = 48000;
const BLOCK = 128;

function paramsOf(cls: any, overrides: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const d of cls.parameterDescriptors as { name: string; defaultValue: number }[]) {
    out[d.name] = Float32Array.from([overrides[d.name] ?? d.defaultValue]);
  }
  return out;
}

/** Render `seconds` of a mono signal through the processor; returns L channel. */
function renderProcessor(
  cls: any,
  params: Record<string, Float32Array>,
  seconds: number,
  input: (i: number) => number,
): Float32Array {
  const proc = new cls();
  const total = Math.ceil(seconds * SR);
  const outAll = new Float32Array(total);
  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    const inp = [Float32Array.from({ length: len }, (_, i) => input(offset + i))];
    const out = [new Float32Array(len), new Float32Array(len)];
    proc.process([inp], [out], params);
    outAll.set(out[0]!.subarray(0, len), offset);
  }
  return outAll;
}

/** Goertzel magnitude at `hz` over the settled tail (skips the first 60 %). */
function goertzelAt(signal: Float32Array, hz: number): number {
  const from = Math.floor(signal.length * 0.6);
  const n = signal.length - from;
  const w = (2 * Math.PI * hz) / SR;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < signal.length; i++) {
    s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
}

function sineAt(hz: number, amp = 0.5): (i: number) => number {
  return (i) => amp * Math.sin((2 * Math.PI * hz * i) / SR);
}

describe("KOREŇ registry contract", () => {
  it("registers on all surfaces with the declared params", () => {
    expect(EFFECT_DEFS.bassHarmonic.params).toEqual(EFFECT_META.bassHarmonic.params);
    expect(EFFECT_META.bassHarmonic.name).toBe("KOREŇ");
    expect(EFFECT_META.bassHarmonic.category).toBe("character");
    expect(WORKLET_EFFECTS.bassHarmonic).toBe("degraded");
  });

  it("clamps garbage to the declared range (NaN → default)", () => {
    expect(clampEffectParam("bassHarmonic", "drive", 5)).toBe(1);
    expect(clampEffectParam("bassHarmonic", "drive", -2)).toBe(0);
    expect(clampEffectParam("bassHarmonic", "focusHz", Number.NaN)).toBe(defaultParamsOf("bassHarmonic").focusHz);
    expect(clampEffectParam("bassHarmonic", "range", 2.4)).toBe(2.4);
    expect(clampEffectParam("bassHarmonic", "range", 99)).toBe(4);
  });

  it("factory falls back to an honest 1:1 bypass without the worklet module", () => {
    const gain = () => ({
      gain: { value: 1 },
      connect() {
        return this;
      },
      disconnect() {},
    });
    const ctx = { createGain: gain, currentTime: 0, sampleRate: SR } as unknown as BaseAudioContext;
    const instance: EffectInstance = {
      id: "bh-fallback",
      type: "bassHarmonic",
      bypassed: false,
      params: defaultParamsOf("bassHarmonic"),
    };
    const rt = EFFECT_DEFS.bassHarmonic.factory(ctx, instance, { bpm: 120 });
    expect(rt.degraded).toBe(true);
    expect(rt.degradedReason).toContain("bass harmonic bypassed");
    rt.dispose();
  });
});

describe("KOREŇ processor behavior", () => {
  it("55 Hz sine gains 2nd-harmonic energy with DRIVE up (Goertzel at 110 Hz)", () => {
    const cls = registered.get("bass-harmonic-processor");
    const wet = renderProcessor(cls, paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0.5 }), 1.5, sineAt(55));
    const dry = renderProcessor(cls, paramsOf(cls, { drive: 0, mix: 1, subAnchor: 0.5 }), 1.5, sineAt(55));
    const h2Wet = goertzelAt(wet, 110);
    const h2Dry = goertzelAt(dry, 110);
    expect(h2Wet).toBeGreaterThan(0.005);
    expect(h2Wet).toBeGreaterThan(h2Dry * 4);
  });

  it("DRIVE 0 generates nothing (no 2H rise over the original)", () => {
    const cls = registered.get("bass-harmonic-processor");
    const dry = renderProcessor(cls, paramsOf(cls, { drive: 0, mix: 1 }), 1.0, sineAt(55));
    expect(goertzelAt(dry, 110)).toBeLessThan(0.001);
  });

  it("SUB ANCHOR 0 removes the original fundamental from the wet path", () => {
    const cls = registered.get("bass-harmonic-processor");
    const anchored = renderProcessor(cls, paramsOf(cls, { mix: 1, subAnchor: 1 }), 1.0, sineAt(55));
    const removed = renderProcessor(cls, paramsOf(cls, { mix: 1, subAnchor: 0 }), 1.0, sineAt(55));
    const f0Anchored = goertzelAt(anchored, 55);
    const f0Removed = goertzelAt(removed, 55);
    expect(f0Anchored).toBeGreaterThan(0.1);
    expect(f0Removed).toBeLessThan(f0Anchored * 0.25);
  });

  it("LOW CUT high-passes the sub-anchor branch (55 Hz under a 200 Hz cut)", () => {
    const cls = registered.get("bass-harmonic-processor");
    const open = renderProcessor(cls, paramsOf(cls, { mix: 1, subAnchor: 1, lowCut: 20, drive: 0 }), 1.0, sineAt(55));
    const cut = renderProcessor(cls, paramsOf(cls, { mix: 1, subAnchor: 1, lowCut: 200, drive: 0 }), 1.0, sineAt(55));
    expect(goertzelAt(cut, 55)).toBeLessThan(goertzelAt(open, 55) * 0.4);
  });

  it("FOCUS window limits tracking (55 Hz outside a 220 Hz focus generates nothing)", () => {
    const cls = registered.get("bass-harmonic-processor");
    const inside = renderProcessor(cls, paramsOf(cls, { drive: 0.9, mix: 1, focusHz: 90 }), 1.2, sineAt(55));
    const outside = renderProcessor(cls, paramsOf(cls, { drive: 0.9, mix: 1, focusHz: 220 }), 1.2, sineAt(55));
    // Reference: same focus window, generator off — the Goertzel reading is
    // then pure filter/DFT leakage, the floor the "outside" case must match.
    const ref = renderProcessor(cls, paramsOf(cls, { drive: 0, mix: 1, focusHz: 220 }), 1.2, sineAt(55));
    const h2Inside = goertzelAt(inside, 110);
    const h2Outside = goertzelAt(outside, 110);
    const h2Ref = goertzelAt(ref, 110);
    expect(h2Inside).toBeGreaterThan(0.005);
    expect(h2Outside).toBeLessThan(h2Inside * 0.35);
    expect(h2Outside).toBeCloseTo(h2Ref, 4);
  });

  it("MIX 0 is a bit-exact dry passthrough", () => {
    const cls = registered.get("bass-harmonic-processor");
    const wet = renderProcessor(cls, paramsOf(cls, { mix: 0 }), 0.3, (i) => Math.sin(i / 3) * 0.7);
    for (let i = 0; i < wet.length; i++) {
      expect(wet[i]).toBe(Math.fround(Math.sin(i / 3) * 0.7));
    }
  });

  it("all params at both extremes stay finite and bounded", () => {
    const cls = registered.get("bass-harmonic-processor");
    const input = (i: number) => Math.sin((2 * Math.PI * 55 * i) / SR) + Math.sin(i / 7);
    const inputPeak = 2; // |sin| + |sin| bound
    for (const d of cls.parameterDescriptors as { name: string; minValue: number; maxValue: number }[]) {
      for (const extreme of [d.minValue, d.maxValue]) {
        const out = renderProcessor(cls, paramsOf(cls, { [d.name]: extreme }), 0.5, input);
        for (const v of out) expect(Number.isFinite(v), `${d.name}@${extreme} non-finite`).toBe(true);
        // Bound = input peak × the legitimate output gain at this extreme ×
        // a harmonic-stack headroom factor. Values beyond that mean runaway.
        const outGainDb = d.name === "output" ? extreme : 0;
        const bound = inputPeak * Math.pow(10, outGainDb / 20) * 1.6 + 1;
        let peak = 0;
        for (const v of out) peak = Math.max(peak, Math.abs(v));
        expect(peak, `${d.name}@${extreme} runaway (peak=${peak})`).toBeLessThan(bound);
      }
    }
  });
});
