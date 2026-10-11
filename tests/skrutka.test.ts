import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_DEFS, WORKLET_EFFECTS, defaultParamsOf } from "../src/effects/registry";
import { EFFECT_META, clampEffectParam } from "../src/effects/definitions";
import { createSkrutkaNode, type SkrutkaMeterFrame } from "../src/audio-worklets/skrutka-node";
import {
  SKRUTKA_PUNCH_R_HARD_MAX,
  skrutkaFieldAmounts,
  skrutkaFocusForChannel,
  skrutkaGroupDelaySamples,
  skrutkaPunchFocus,
} from "../src/effects/skrutka-curve";
import type { EffectInstance } from "../src/project-model/types";

/**
 * TWIST (skrutka) — behavioral pins.
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
  extras?: { key?: (i: number) => number },
): Float32Array {
  const proc = new cls();
  const total = Math.ceil(seconds * SR);
  const outAll = new Float32Array(total);
  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    const inputs: Float32Array[][] = [[Float32Array.from({ length: len }, (_, i) => input(offset + i))]];
    if (extras?.key) {
      inputs.push([Float32Array.from({ length: len }, (_, i) => extras.key!(offset + i))]);
    }
    const out = [new Float32Array(len), new Float32Array(len)];
    proc.process(inputs, [out], params);
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
  right?: (i: number) => number,
): { L: Float32Array; R: Float32Array } {
  const proc = new cls();
  const total = Math.ceil(seconds * SR);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    const inp = [
      Float32Array.from({ length: len }, (_, i) => input(offset + i)),
      Float32Array.from({ length: len }, (_, i) => (right ?? input)(offset + i)),
    ];
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

describe("TWIST registry contract", () => {
  it("registers on all surfaces with the declared params", () => {
    expect(EFFECT_DEFS.skrutka.params).toEqual(EFFECT_META.skrutka.params);
    expect(EFFECT_META.skrutka.name).toBe("TWIST");
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

describe("TWIST processor behavior (phase-only)", () => {
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

describe("TWIST v2 (shape / dynamic / key / punch controls / LFO)", () => {
  it("SHAPE redistributes the hump: CHIRP / DOUBLE / RESO all differ from GULP", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.7, punch: 0, focusHz: 320, spread: 0 };
    const render = (shape: number) => renderProcessor(cls, paramsOf(cls, { ...base, shape }), 1.2, sineAt(320));
    const gulp = render(0);
    for (const shape of [1, 2, 3]) {
      const other = render(shape);
      let maxDiff = 0;
      for (let i = 0; i < gulp.length; i++) maxDiff = Math.max(maxDiff, Math.abs(gulp[i]! - other[i]!));
      expect(maxDiff, `shape ${shape} vs GULP`).toBeGreaterThan(0.01);
    }
  });

  it("CHIRP and RESO still match the analytic curve model", () => {
    const cls = registered.get("skrutka-processor");
    for (const shape of [1, 3]) {
      const base = { dispersion: 0.7, punch: 0, focusHz: 320, spread: 0, shape };
      for (const f of [200, 320]) {
        const measured = measuredGroupDelay(cls, base, f);
        const model = skrutkaGroupDelaySamples(base, SR, f, "L");
        expect(Math.abs(measured - model), `shape=${shape} f=${f} measured=${measured} model=${model}`).toBeLessThan(
          Math.max(2, model * 0.3),
        );
      }
    }
  });

  it("DYNAMIC: BODY deepens on sustain, ATTACK deepens on transients", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.3, punch: 0, focusHz: 90, spread: 0, mix: 1 };
    // Steady 80 Hz tone: bodyness ≈ 1, attackness ≈ 0 after the settle.
    const steadyTail = (dyn: number) => {
      const out = renderProcessor(cls, paramsOf(cls, { ...base, dyn }), 1.4, sineAt(80, 0.4));
      const from = Math.floor(out.length * 0.7);
      const w = (2 * Math.PI * 80) / SR;
      let iPart = 0;
      let qPart = 0;
      for (let i = from; i < out.length; i++) {
        iPart += out[i]! * Math.cos(w * i);
        qPart += out[i]! * Math.sin(w * i);
      }
      return Math.atan2(iPart, qPart);
    };
    const bodyShift = Math.abs(wrapPi(steadyTail(-1) - steadyTail(0)));
    const attackShift = Math.abs(wrapPi(steadyTail(1) - steadyTail(0)));
    expect(bodyShift).toBeGreaterThan(0.15); // BODY moves the steady state
    expect(bodyShift).toBeGreaterThan(attackShift * 3); // ATTACK does not

    // Single-note shape: ATTACK mode's phase shift is concentrated at the
    // note's onset and decays away; BODY mode is ~0 at the onset (its score
    // is attack-suppressed) and grows once the note settles.
    const note = (i: number) => {
      const t = i / SR;
      return t > 0.05 && t < 0.55 ? 0.4 * Math.sin((2 * Math.PI * 80 * i) / SR) : 0;
    };
    const reference = renderProcessor(cls, paramsOf(cls, { ...base, dyn: 0 }), 0.6, note);
    const diffEnergy = (dyn: number, fromS: number, toS: number) => {
      const wet = renderProcessor(cls, paramsOf(cls, { ...base, dyn }), 0.6, note);
      let sum = 0;
      for (let i = Math.round(fromS * SR); i < Math.round(toS * SR); i++) {
        const d = wet[i]! - reference[i]!;
        sum += d * d;
      }
      return sum;
    };
    const attackEarly = diffEnergy(1, 0.055, 0.095);
    const attackSettled = diffEnergy(1, 0.35, 0.45);
    const bodyEarly = diffEnergy(-1, 0.055, 0.095);
    const bodySettled = diffEnergy(-1, 0.35, 0.45);
    expect(attackEarly).toBeGreaterThan(attackSettled * 2); // ATTACK decays after the onset
    expect(bodySettled).toBeGreaterThan(bodyEarly * 2); // BODY grows once settled
    expect(attackEarly).toBeGreaterThan(bodyEarly * 2); // ATTACK reacts first
  });

  it("KEY PUMP deepens and DUCK thins the hump on the key envelope", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.3, punch: 0, focusHz: 90, spread: 0, mix: 1 };
    const keyBurst = (i: number) => {
      const t = i / SR;
      return t >= 0.5 && t < 0.8 ? 0.8 * Math.sin((2 * Math.PI * 60 * i) / SR) : 0;
    };
    const phaseIn = (out: Float32Array, from: number, to: number) => {
      const w = (2 * Math.PI * 80) / SR;
      let iPart = 0;
      let qPart = 0;
      for (let i = from; i < to; i++) {
        iPart += out[i]! * Math.cos(w * i);
        qPart += out[i]! * Math.sin(w * i);
      }
      return Math.atan2(iPart, qPart);
    };
    // The key-induced CHANGE of the wet-vs-dry phase: during the key burst
    // against the pre-key reference (removes the static dispersion shift).
    const keyDelta = (keyMode: number) => {
      const wet = renderProcessor(cls, paramsOf(cls, { ...base, keyMode }), 1.0, sineAt(80, 0.4), { key: keyBurst });
      const dry = renderProcessor(cls, paramsOf(cls, { ...base, keyMode, mix: 0 }), 1.0, sineAt(80, 0.4), {
        key: keyBurst,
      });
      const before = wrapPi(
        phaseIn(wet, Math.round(0.35 * SR), Math.round(0.45 * SR)) -
          phaseIn(dry, Math.round(0.35 * SR), Math.round(0.45 * SR)),
      );
      const during = wrapPi(
        phaseIn(wet, Math.round(0.6 * SR), Math.round(0.75 * SR)) -
          phaseIn(dry, Math.round(0.6 * SR), Math.round(0.75 * SR)),
      );
      return wrapPi(during - before);
    };
    const pump = keyDelta(1);
    const duck = keyDelta(2);
    const off = keyDelta(0);
    expect(Math.abs(off)).toBeLessThan(0.05); // no key → no modulation
    expect(Math.abs(pump)).toBeGreaterThan(0.1); // PUMP moves the phase with the key
    expect(Math.abs(duck)).toBeGreaterThan(0.1); // DUCK moves it too
    // PUMP deepens the hump (more delay) and DUCK thins it — opposite signs.
    expect(Math.sign(pump) * Math.sign(duck)).toBeLessThan(0);
  });

  it("KEY mode without a key feed is a bit-exact no-op (PUMP and DUCK)", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.6, punch: 0.4, focusHz: 200, spread: 0.3, mix: 0.8 };
    const plain = renderProcessor(cls, paramsOf(cls, { ...base, keyMode: 0 }), 1.0, sineAt(80, 0.4));
    expect(renderProcessor(cls, paramsOf(cls, { ...base, keyMode: 1 }), 1.0, sineAt(80, 0.4))).toEqual(plain);
    expect(renderProcessor(cls, paramsOf(cls, { ...base, keyMode: 2 }), 1.0, sineAt(80, 0.4))).toEqual(plain);
  });

  it("PUNCH FOCUS overrides the AUTO center; PUNCH MIX 0 is the long stage", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.35, punch: 1, focusHz: 220, spread: 0, punchMix: 1 };
    const auto = measuredGroupDelay(cls, base, 63);
    const explicit = measuredGroupDelay(cls, { ...base, punchHz: 1200 }, 1200);
    const explicitAtBody = measuredGroupDelay(cls, base, 1200);
    expect(explicit).toBeGreaterThan(explicitAtBody * 1.5); // the hump moved to 1200
    expect(auto).toBeGreaterThan(explicitAtBody); // AUTO keeps it at the body band
    // punchMix 0 removes the punch stage entirely → equal to punch = 0.
    const noPunch = renderProcessor(cls, paramsOf(cls, { ...base, punch: 0, punchMix: 0 }), 1.0, sineAt(80, 0.4));
    const fullLong = renderProcessor(cls, paramsOf(cls, { ...base, punch: 0, punchMix: 1 }), 1.0, sineAt(80, 0.4));
    expect(noPunch).toEqual(fullLong);
  });

  it("LFO sweeps FOCUS: depth moves the phase over time, deterministic across runs", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.7, punch: 0, focusHz: 300, spread: 0 };
    const moving = (i: number) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / SR);
    const still = renderProcessor(cls, paramsOf(cls, { ...base, mix: 0 }), 1.2, moving);
    const swept = renderProcessor(cls, paramsOf(cls, { ...base, lfoHz: 4, lfoDepth: 1 }), 1.2, moving);
    const swept2 = renderProcessor(cls, paramsOf(cls, { ...base, lfoHz: 4, lfoDepth: 1 }), 1.2, moving);
    let maxDiff = 0;
    for (let i = 0; i < still.length; i++) maxDiff = Math.max(maxDiff, Math.abs(still[i]! - swept[i]!));
    expect(maxDiff).toBeGreaterThan(0.05); // the sweep audibly moves the phase
    expect(swept).toEqual(swept2); // deterministic
  });
});

describe("TWIST v2.1 (FIELD — M/S dispersion field)", () => {
  it("field = +1 is bit-transparent for mono content (sides-only dispersion)", () => {
    const cls = registered.get("skrutka-processor");
    const input = (i: number) => 0.4 * Math.sin((2 * Math.PI * 80 * i) / SR) + 0.1 * Math.sin(i / 3);
    const out = renderProcessorStereo(
      cls,
      paramsOf(cls, { field: 1, dispersion: 0.8, focusHz: 90, spread: 0.5, mix: 1 }),
      0.5,
      input,
    );
    for (let i = 0; i < out.L.length; i++) {
      expect(out.L[i]).toBe(Math.fround(input(i)));
      expect(out.R[i]).toBe(Math.fround(input(i)));
    }
  });

  it("field = +1 disperses only the side component; field = −1 only the mid", () => {
    const cls = registered.get("skrutka-processor");
    const left = (i: number) =>
      0.3 * Math.sin((2 * Math.PI * 80 * i) / SR) + 0.08 * Math.sin((2 * Math.PI * 2400 * i) / SR);
    const right = (i: number) =>
      0.25 * Math.sin((2 * Math.PI * 80 * i) / SR + 0.9) + 0.06 * Math.sin((2 * Math.PI * 3100 * i) / SR);
    const base = { dispersion: 0.7, punch: 0, focusHz: 200, spread: 0.4, mix: 1 };
    const dry = renderProcessorStereo(cls, paramsOf(cls, { ...base, mix: 0 }), 0.8, left, right);
    const sideOnly = renderProcessorStereo(cls, paramsOf(cls, { ...base, field: 1 }), 0.8, left, right);
    const midOnly = renderProcessorStereo(cls, paramsOf(cls, { ...base, field: -1 }), 0.8, left, right);
    let midDiffSide = 0;
    let sideDiffSideOnly = 0;
    let sideDiffMidOnly = 0;
    let midDiffMidOnly = 0;
    for (let i = Math.floor(dry.L.length * 0.3); i < dry.L.length; i++) {
      midDiffSide = Math.max(
        midDiffSide,
        Math.abs((sideOnly.L[i]! + sideOnly.R[i]!) / 2 - (dry.L[i]! + dry.R[i]!) / 2),
      );
      sideDiffSideOnly = Math.max(
        sideDiffSideOnly,
        Math.abs((sideOnly.L[i]! - sideOnly.R[i]!) / 2 - (dry.L[i]! - dry.R[i]!) / 2),
      );
      sideDiffMidOnly = Math.max(
        sideDiffMidOnly,
        Math.abs((midOnly.L[i]! - midOnly.R[i]!) / 2 - (dry.L[i]! - dry.R[i]!) / 2),
      );
      midDiffMidOnly = Math.max(
        midDiffMidOnly,
        Math.abs((midOnly.L[i]! + midOnly.R[i]!) / 2 - (dry.L[i]! + dry.R[i]!) / 2),
      );
    }
    expect(midDiffSide).toBeLessThan(1e-6); // mid stays dry
    expect(sideDiffSideOnly).toBeGreaterThan(0.01); // side is dispersed
    expect(sideDiffMidOnly).toBeLessThan(1e-6); // side stays dry
    expect(midDiffMidOnly).toBeGreaterThan(0.01); // mid is dispersed
  });

  it("field below the topology threshold is bit-exact legacy", () => {
    const cls = registered.get("skrutka-processor");
    const base = { dispersion: 0.6, punch: 0.4, focusHz: 260, spread: 0.5, mix: 0.9 };
    const legacy = renderProcessor(cls, paramsOf(cls, base), 0.8, sineAt(80, 0.4));
    const nearZero = renderProcessor(cls, paramsOf(cls, { ...base, field: 0.00005 }), 0.8, sineAt(80, 0.4));
    expect(nearZero).toEqual(legacy);
  });

  it("keeps the automated transition out of the legacy FIELD basis click-safe", () => {
    const cls = registered.get("skrutka-processor");
    const left = (i: number) =>
      0.24 * Math.sin((2 * Math.PI * 83 * i) / SR) + 0.12 * Math.sin((2 * Math.PI * 1700 * i) / SR);
    const right = (i: number) =>
      0.18 * Math.sin((2 * Math.PI * 137 * i) / SR + 0.3) + 0.09 * Math.sin((2 * Math.PI * 2700 * i) / SR);
    const base = { dispersion: 0.75, focusHz: 320, spread: 0.8, mix: 1, field: 0 };
    const seconds = 0.8;
    const transitionSample = Math.floor((seconds * SR) / 2 / BLOCK) * BLOCK;
    const baseline = renderProcessorStereo(cls, paramsOf(cls, base), seconds, left, right);
    const proc = new cls();
    const params = paramsOf(cls, base);
    const total = Math.ceil(seconds * SR);
    const outL = new Float32Array(total);
    const outR = new Float32Array(total);

    for (let offset = 0; offset < total; offset += BLOCK) {
      if (offset >= transitionSample) params.field![0] = 0.8;
      const len = Math.min(BLOCK, total - offset);
      const inputs = [
        Float32Array.from({ length: len }, (_, i) => left(offset + i)),
        Float32Array.from({ length: len }, (_, i) => right(offset + i)),
      ];
      const outputs = [new Float32Array(len), new Float32Array(len)];
      proc.process([inputs], [outputs], params);
      outL.set(outputs[0]!.subarray(0, len), offset);
      outR.set(outputs[1]!.subarray(0, len), offset);
    }

    let firstBlockPeakDelta = 0;
    let firstSampleDeltaStep = 0;
    let settledDelta = 0;
    for (let i = transitionSample; i < Math.min(total, transitionSample + Math.floor(0.12 * SR)); i++) {
      const deltaL = outL[i]! - baseline.L[i]!;
      const deltaR = outR[i]! - baseline.R[i]!;
      settledDelta = Math.max(settledDelta, Math.abs(deltaL), Math.abs(deltaR));
      if (i < transitionSample + BLOCK)
        firstBlockPeakDelta = Math.max(firstBlockPeakDelta, Math.abs(deltaL), Math.abs(deltaR));
      if (i === transitionSample) {
        firstSampleDeltaStep = Math.max(
          Math.abs(deltaL - (outL[i - 1]! - baseline.L[i - 1]!)),
          Math.abs(deltaR - (outR[i - 1]! - baseline.R[i - 1]!)),
        );
      }
    }
    expect(settledDelta).toBeGreaterThan(0.01);
    expect(firstSampleDeltaStep).toBeLessThan(0.01);
    expect(firstBlockPeakDelta).toBeLessThan(0.05);
  });

  it("the curve model exposes the FIELD amounts and the M/S focus split", () => {
    expect(skrutkaFieldAmounts(1)).toEqual({ mid: 0, side: 1 });
    expect(skrutkaFieldAmounts(-1)).toEqual({ mid: 1, side: 0 });
    expect(skrutkaFieldAmounts(0.5)).toEqual({ mid: 0.5, side: 1 });
    expect(skrutkaFieldAmounts(-0.5)).toEqual({ mid: 1, side: 0.5 });
    expect(skrutkaFocusForChannel(220, 1, "M")).toBeCloseTo(220, 6);
    expect(skrutkaFocusForChannel(220, 1, "M", 0)).toBeCloseTo(220 * 0.88, 6);
    expect(skrutkaFocusForChannel(220, 1, "M", 0.5)).toBeCloseTo(220 * 0.94, 6);
    expect(skrutkaFocusForChannel(220, 1, "S")).toBeGreaterThan(skrutkaFocusForChannel(220, 1, "M"));
    // SPREAD splits the component curves: M (centered) and S (offset) carry
    // measurably different arrival times.
    const cp = { dispersion: 0.8, punch: 0, focusHz: 300, spread: 1, field: 1 };
    const mAtFocus = skrutkaGroupDelaySamples(cp, SR, 300, "M");
    const sAtFocus = skrutkaGroupDelaySamples(cp, SR, 300, "S");
    const sFocus = skrutkaFocusForChannel(300, 1, "S");
    expect(mAtFocus).toBeGreaterThan(sAtFocus);
    expect(
      Math.abs(skrutkaGroupDelaySamples(cp, SR, sFocus, "M") - skrutkaGroupDelaySamples(cp, SR, sFocus, "S")),
    ).toBeGreaterThan(0.5);
  });
});

describe("TWIST v2.2 (DYNAMIC PUNCH — envelope-driven punch radius)", () => {
  const note = (i: number) => {
    const t = i / SR;
    return t > 0.05 && t < 0.55 ? 0.4 * Math.sin((2 * Math.PI * 80 * i) / SR) : 0;
  };
  const base = { dispersion: 0, punch: 0, focusHz: 220, spread: 0, mix: 1 };
  const diffEnergy = (dynPunch: number, fromS: number, toS: number) => {
    const cls = registered.get("skrutka-processor");
    const reference = renderProcessor(cls, paramsOf(cls, { ...base, dynPunch: 0 }), 0.6, note);
    const wet = renderProcessor(cls, paramsOf(cls, { ...base, dynPunch }), 0.6, note);
    let sum = 0;
    for (let i = Math.round(fromS * SR); i < Math.round(toS * SR); i++) {
      const d = wet[i]! - reference[i]!;
      sum += d * d;
    }
    return sum;
  };

  it("dynPunch = +1 opens the punch stage on the onset (even with punch = 0)", () => {
    const attackEarly = diffEnergy(1, 0.055, 0.095);
    const attackSettled = diffEnergy(1, 0.35, 0.45);
    expect(attackEarly).toBeGreaterThan(0.5); // the stage actually opens from zero
    expect(attackEarly).toBeGreaterThan(attackSettled * 2); // and decays after the onset
  });

  it("dynPunch = −1 bites on the sustain and leaves the attack alone", () => {
    const bodyEarly = diffEnergy(-1, 0.055, 0.095);
    const bodySettled = diffEnergy(-1, 0.35, 0.45);
    const attackEarly = diffEnergy(1, 0.055, 0.095);
    const attackSettled = diffEnergy(1, 0.35, 0.45);
    expect(bodySettled).toBeGreaterThan(0.5);
    expect(bodySettled).toBeGreaterThan(bodyEarly * 2);
    // The two directions are complementary, not duplicates.
    expect(attackEarly).toBeGreaterThan(bodyEarly);
    expect(bodySettled).toBeGreaterThan(attackSettled);
  });

  it("dynPunch = 0 changes nothing (v2.1 render bit-exact)", () => {
    const cls = registered.get("skrutka-processor");
    const opts = { dispersion: 0.6, punch: 0.5, focusHz: 240, spread: 0.4, mix: 0.9, dyn: 0.5 };
    const withParam = renderProcessor(cls, paramsOf(cls, { ...opts, dynPunch: 0 }), 0.8, note);
    const withoutParam = renderProcessor(cls, paramsOf(cls, opts), 0.8, note);
    expect(withParam).toEqual(withoutParam);
  });

  it("the model exposes the dynamic punch ceiling", () => {
    const cp = { dispersion: 0, punch: 1, focusHz: 220, spread: 0 };
    const f = skrutkaPunchFocus(220, 1, 0, SR);
    const baseDelay = skrutkaGroupDelaySamples(cp, SR, f, "L");
    const drivenDelay = skrutkaGroupDelaySamples(cp, SR, f, "L", undefined, SKRUTKA_PUNCH_R_HARD_MAX);
    expect(drivenDelay).toBeGreaterThan(baseDelay * 1.2);
  });
});

describe("TWIST node wrapper (key input + telemetry cache + LFO sync)", () => {
  class FakeParam {
    value = 0;
    scheduled: number[] = [];
    setValueAtTime(v: number) {
      this.scheduled.push(v);
    }
  }
  class FakeWorkletNode {
    static instances: FakeWorkletNode[] = [];
    port = new FakePort();
    pmap = new Map<string, FakeParam>();
    parameters = {
      get: (id: string) => {
        let p = this.pmap.get(id);
        if (!p) {
          p = new FakeParam();
          this.pmap.set(id, p);
        }
        return p;
      },
    };
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

  const makeSource = (calls: string[]): AudioNode =>
    ({
      connect: (_target: unknown, output?: number, input?: number) => calls.push(`connect:${output}:${input}`),
      disconnect: (_target: unknown, output?: number, input?: number) => calls.push(`disconnect:${output}:${input}`),
    }) as unknown as AudioNode;

  beforeAll(() => {
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
  });

  it("creates a stereo 2-input node with the seeded LFO and dispose is idempotent", () => {
    const runtime = createSkrutkaNode(makeCtx(), { params: { dispersion: 0.5 } }, { bpm: 120, seed: 42 });
    const node = FakeWorkletNode.instances.at(-1)!;
    const options = node.options as {
      numberOfInputs: number;
      outputChannelCount: number[];
      processorOptions: { seed: number };
    };
    expect(options.numberOfInputs).toBe(2);
    expect(options.outputChannelCount).toEqual([2]);
    expect(options.processorOptions.seed).toBe(42);
    runtime.dispose();
    runtime.dispose();
  });

  it("wires the key with identical-repoint no-ops and detaches on dispose", () => {
    const runtime = createSkrutkaNode(makeCtx(), { params: {} });
    const calls: string[] = [];
    const source = makeSource(calls);
    runtime.setSidechainInput!(source);
    expect(calls).toEqual(["connect:0:1"]);
    runtime.setSidechainInput!(source);
    expect(calls).toEqual(["connect:0:1"]);
    const replacement = makeSource(calls);
    runtime.setSidechainInput!(replacement);
    expect(calls).toEqual(["connect:0:1", "disconnect:0:1", "connect:0:1"]);
    runtime.setSidechainInput!(null);
    expect(calls.at(-1)).toBe("disconnect:0:1");
    runtime.dispose();
  });

  it("routes lfoRate/lfoSync through the sync controller and anchors the phase at transport start", () => {
    const runtime = createSkrutkaNode(makeCtx(), { params: { lfoRate: 0.5, lfoSync: 0 } }, { bpm: 120 });
    const node = FakeWorkletNode.instances.at(-1)!;
    runtime.setParameter("lfoRate", 2);
    expect(node.pmap.get("lfoHz")?.value).toBeCloseTo(2, 6); // sync OFF → free Hz
    runtime.setParameter("lfoSync", 2); // 1/8 = 2 cycles per beat at 120 BPM → 4 Hz
    expect(node.pmap.get("lfoHz")?.value).toBeCloseTo(4, 6);
    runtime.syncBpm?.(90, 0);
    expect(node.pmap.get("lfoHz")?.scheduled.at(-1)).toBeCloseTo(3, 6); // 90/60 × 2
    runtime.onTransportStarted?.(1.5, 0, 2.25); // position 2.25 beats × 2 cycles/beat = 4.5 → phase 0.5
    expect(node.pmap.get("lfoPhase")?.scheduled.at(-1)).toBeCloseTo(0.5, 6);
    runtime.dispose();
  });

  it("caches only validated skrutka frames for getMeters", () => {
    const runtime = createSkrutkaNode(makeCtx(), { params: {} });
    const node = FakeWorkletNode.instances.at(-1)!;
    expect(runtime.getMeters!()).toBeNull();
    node.port.onmessage!({ data: { type: "skrutka", lfo: 0.25, env: 0.4, key: 1.2, radius: 0.8 } });
    const frame = runtime.getMeters!() as SkrutkaMeterFrame;
    expect(frame.lfo).toBe(0.25);
    expect(frame.radius).toBe(0.8);
    // Shape violations and foreign messages never replace the cached frame.
    node.port.onmessage!({ data: { type: "skrutka", lfo: Number.NaN, env: 0, key: 1, radius: 0.5 } });
    node.port.onmessage!({ data: { type: "koren", f0: 55 } });
    node.port.onmessage!({ data: null });
    expect(runtime.getMeters!()).toBe(frame);
    runtime.dispose();
    expect(runtime.getMeters!()).toBeNull();
  });
});
