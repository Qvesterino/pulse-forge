import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_DEFS, WORKLET_EFFECTS, defaultParamsOf } from "../src/effects/registry";
import { EFFECT_META, clampEffectParam } from "../src/effects/definitions";
import { createSkrutkaNode } from "../src/audio-worklets/skrutka-node";
import { skrutkaGroupDelaySamples } from "../src/effects/skrutka-curve";
import type { EffectInstance } from "../src/project-model/types";

/**
 * SKRUTKA (skrutka) — behavioral pins.
 *
 * The effect is all-pass-only, so the DSP claims are about PHASE, not level:
 *   1. mix = 0 is a bit-exact dry passthrough (and the first block adopts the
 *      written params exactly);
 *   2. amplitude is preserved while the phase shifts (|H| = 1);
 *   3. the measured group delay matches the analytic curve module at the
 *      frequencies the panel draws (model↔processor lockstep);
 *   4. FOCUS moves the delay hump; the sign of PUNCH picks which band is
 *      delayed (body below focus vs click band above it);
 *   5. SPREAD = 0 renders L and R bit-identically (mono-safe), SPREAD > 0
 *      decorrelates the channels;
 *   6. every param stays finite and bounded at both extremes.
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown) {
    this.posted.push(message);
  }
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
  await import("../src/audio-worklets/skrutka-processor.js");
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

/** Same as renderProcessor but returns both output channels. */
function renderProcessorStereo(
  cls: any,
  params: Record<string, Float32Array>,
  seconds: number,
  input: (i: number) => number,
): { L: Float32Array; R: Float32Array } {
  const proc = new cls();
  const total = Math.ceil(seconds * SR);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    const inp = [Float32Array.from({ length: len }, (_, i) => input(offset + i))];
    const out = [new Float32Array(len), new Float32Array(len)];
    proc.process([inp], [out], params);
    outL.set(out[0]!.subarray(0, len), offset);
    outR.set(out[1]!.subarray(0, len), offset);
  }
  return { L: outL, R: outR };
}

/** Goertzel magnitude at `hz` over the settled tail (skips the first 60 %). */
function goertzelAt(signal: Float32Array, hz: number): number {
  const from = Math.floor(signal.length * 0.6);
  const n = signal.length - from;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < signal.length; i++) {
    const s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

/** Phase of the `hz` component in `signal` (x = A·sin(ωi + p) → returns p). */
function phaseAt(signal: Float32Array, hz: number): number {
  const from = Math.floor(signal.length * 0.6);
  const w = (2 * Math.PI * hz) / SR;
  let iPart = 0;
  let qPart = 0;
  for (let i = from; i < signal.length; i++) {
    iPart += signal[i]! * Math.cos(w * i);
    qPart += signal[i]! * Math.sin(w * i);
  }
  return Math.atan2(iPart, qPart);
}

const wrapPi = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

const sineAt =
  (hz: number, amp = 0.5): ((i: number) => number) =>
  (i) =>
    amp * Math.sin((2 * Math.PI * hz * i) / SR);

/**
 * Measured group delay (samples) around `hz`: central difference of the
 * wet-vs-dry phase shift over ±df. Dry renders (mix 0) share the window so
 * the difference is the filter's own phase.
 */
function measuredGroupDelay(cls: any, base: Record<string, number>, hz: number, df = 15): number {
  const wet = (f: number) => renderProcessor(cls, paramsOf(cls, { ...base, mix: 1 }), 1.4, sineAt(f));
  const dry = (f: number) => renderProcessor(cls, paramsOf(cls, { ...base, mix: 0 }), 1.4, sineAt(f));
  const shift = (f: number) => wrapPi(phaseAt(wet(f), f) - phaseAt(dry(f), f));
  const dOmega = (2 * Math.PI * df) / SR;
  return -(wrapPi(shift(hz + df) - shift(hz - df)) / (2 * dOmega));
}

describe("SKRUTKA registry contract", () => {
  it("registers on all surfaces with the declared params", () => {
    expect(EFFECT_DEFS.skrutka.params).toEqual(EFFECT_META.skrutka.params);
    expect(EFFECT_META.skrutka.name).toBe("SKRUTKA");
    expect(EFFECT_META.skrutka.category).toBe("character");
    expect(WORKLET_EFFECTS.skrutka).toBe("degraded");
  });

  it("clamps garbage to the declared range (NaN → default)", () => {
    expect(clampEffectParam("skrutka", "dispersion", 5)).toBe(1);
    expect(clampEffectParam("skrutka", "dispersion", -2)).toBe(0);
    expect(clampEffectParam("skrutka", "punch", -3)).toBe(-1);
    expect(clampEffectParam("skrutka", "punch", 3)).toBe(1);
    expect(clampEffectParam("skrutka", "focusHz", Number.NaN)).toBe(defaultParamsOf("skrutka").focusHz);
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
      id: "sk-fallback",
      type: "skrutka",
      bypassed: false,
      params: defaultParamsOf("skrutka"),
    };
    const rt = EFFECT_DEFS.skrutka.factory(ctx, instance, { bpm: 120 });
    expect(rt.degraded).toBe(true);
    expect(rt.degradedReason).toContain("phase dispersion bypassed");
    rt.dispose();
  });
});

describe("SKRUTKA processor behavior (phase-only)", () => {
  it("MIX 0 is a bit-exact dry passthrough (first block adopts written params)", () => {
    const cls = registered.get("skrutka-processor");
    const out = renderProcessor(
      cls,
      paramsOf(cls, { mix: 0, dispersion: 1, punch: 1 }),
      0.3,
      (i) => Math.sin(i / 3) * 0.7,
    );
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(Math.fround(Math.sin(i / 3) * 0.7));
    }
  });

  it("preserves level while shifting phase (all-pass: |H| = 1)", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.6, focusHz: 320, mix: 1 };
    const wet = renderProcessor(cls, paramsOf(cls, base), 1.4, sineAt(320));
    const dry = renderProcessor(cls, paramsOf(cls, { ...base, mix: 0 }), 1.4, sineAt(320));
    const levelWet = goertzelAt(wet, 320);
    const levelDry = goertzelAt(dry, 320);
    expect(levelWet).toBeGreaterThan(levelDry * 0.95);
    expect(levelWet).toBeLessThan(levelDry * 1.05);
    const phaseShift = Math.abs(wrapPi(phaseAt(wet, 320) - phaseAt(dry, 320)));
    expect(phaseShift).toBeGreaterThan(0.1);
  });

  it("measured group delay matches the analytic curve at the focus and off it", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.6, punch: 0, focusHz: 320, spread: 0 };
    for (const f of [200, 320, 640]) {
      const measured = measuredGroupDelay(cls, base, f);
      const model = skrutkaGroupDelaySamples(base, SR, f, "L");
      expect(Math.abs(measured - model), `f=${f} measured=${measured} model=${model}`).toBeLessThan(
        Math.max(2, model * 0.3),
      );
    }
  });

  it("FOCUS moves the delay hump (the larger delay follows the focus)", () => {
    const cls = registered.get("skrutka-processor");
    const low = { dispersion: 0.9, punch: 0, focusHz: 150, spread: 0 };
    const high = { dispersion: 0.9, punch: 0, focusHz: 1500, spread: 0 };
    const lowAt150 = measuredGroupDelay(cls, low, 150);
    const lowAt1500 = measuredGroupDelay(cls, low, 1500);
    const highAt150 = measuredGroupDelay(cls, high, 150);
    const highAt1500 = measuredGroupDelay(cls, high, 1500);
    expect(lowAt150).toBeGreaterThan(lowAt1500 * 2);
    expect(highAt1500).toBeGreaterThan(highAt150 * 1.8);
  });

  it("PUNCH sign picks the delayed band (body below focus vs click band above)", () => {
    const cls = registered.get("skrutka-processor");
    const focusHz = 220;
    const base = { dispersion: 0.35, focusHz, spread: 0 };
    const positive = { ...base, punch: 1 };
    const negative = { ...base, punch: -1 };
    const neutral = { ...base, punch: 0 };
    const body = Math.round(focusHz / 3.5); // positive-punch center
    const click = Math.round(focusHz * 3.5); // negative-punch center
    const posBody = measuredGroupDelay(cls, positive, body);
    const negBody = measuredGroupDelay(cls, negative, body);
    const posClick = measuredGroupDelay(cls, positive, click);
    const negClick = measuredGroupDelay(cls, negative, click);
    const baseBody = measuredGroupDelay(cls, neutral, body);
    const baseClick = measuredGroupDelay(cls, neutral, click);
    // At the body band, positive PUNCH delays measurably more than negative
    // and than the punch-off baseline.
    expect(posBody).toBeGreaterThan(negBody * 1.8);
    expect(posBody).toBeGreaterThan(baseBody * 3);
    // At the click band, negative PUNCH delays measurably more than positive
    // and than the punch-off baseline.
    expect(negClick).toBeGreaterThan(posClick * 1.25);
    expect(negClick).toBeGreaterThan(baseClick * 2);
  });

  it("SPREAD 0 is bit-exact mono; SPREAD 1 decorrelates the channels", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.6, punch: 0, focusHz: 500 };
    const input = (i: number) => Math.sin((2 * Math.PI * 180 * i) / SR) + 0.4 * Math.sin((2 * Math.PI * 1500 * i) / SR);
    const mono = renderProcessorStereo(cls, paramsOf(cls, { ...base, spread: 0 }), 1.0, input);
    expect(mono.L).toEqual(mono.R);
    const wide = renderProcessorStereo(cls, paramsOf(cls, { ...base, spread: 1 }), 1.0, input);
    let maxDiff = 0;
    for (let i = 0; i < wide.L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(wide.L[i]! - wide.R[i]!));
    expect(maxDiff).toBeGreaterThan(1e-4);
  });

  it("all params at both extremes stay finite and bounded", () => {
    const cls = registered.get("skrutka-processor");
    const input = (i: number) => Math.sin((2 * Math.PI * 55 * i) / SR) + Math.sin(i / 7);
    const inputPeak = 2;
    for (const d of cls.parameterDescriptors as { name: string; minValue: number; maxValue: number }[]) {
      for (const extreme of [d.minValue, d.maxValue]) {
        const out = renderProcessor(cls, paramsOf(cls, { [d.name]: extreme }), 0.5, input);
        for (const v of out) expect(Number.isFinite(v), `${d.name}@${extreme} non-finite`).toBe(true);
        const outGainDb = d.name === "output" ? extreme : 0;
        const bound = inputPeak * Math.pow(10, outGainDb / 20) * 1.3 + 0.5;
        let peak = 0;
        for (const v of out) peak = Math.max(peak, Math.abs(v));
        expect(peak, `${d.name}@${extreme} runaway (peak=${peak})`).toBeLessThan(bound);
      }
    }
  });
});

describe("SKRUTKA node wrapper", () => {
  class FakeWorkletNode {
    static instances: FakeWorkletNode[] = [];
    port = new FakePort();
    parameters = { get: () => ({ value: 0, setValueAtTime() {} }) };
    onprocessorerror: (() => void) | null = null;
    options: unknown;
    constructor(_ctx: unknown, _name: string, options: unknown) {
      this.options = options;
      FakeWorkletNode.instances.push(this);
    }
    connect() {}
    disconnect() {}
  }

  const makeCtx = () =>
    ({
      createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} }),
      currentTime: 0,
      sampleRate: SR,
    }) as unknown as BaseAudioContext;

  beforeAll(() => {
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
  });

  it("creates a stereo 1-input node and dispose is idempotent", () => {
    const runtime = createSkrutkaNode(makeCtx(), { params: { dispersion: 0.5 } });
    const node = FakeWorkletNode.instances.at(-1)!;
    const options = node.options as { numberOfInputs: number; outputChannelCount: number[] };
    expect(options.numberOfInputs).toBe(1);
    expect(options.outputChannelCount).toEqual([2]);
    runtime.dispose();
    runtime.dispose();
  });
});
