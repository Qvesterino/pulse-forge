import { beforeAll, describe, expect, it } from "vitest";
import { EFFECT_DEFS, WORKLET_EFFECTS, defaultParamsOf } from "../src/effects/registry";
import { EFFECT_META, clampEffectParam } from "../src/effects/definitions";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";
import { createBassHarmonicNode, type KorenMeterFrame } from "../src/audio-worklets/bass-harmonic-node";
import type { EffectInstance } from "../src/project-model/types";

/**
 * GROW (bassHarmonic) — behavioral pins.
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
  posted: unknown[] = [];
  postMessage(message: unknown) {
    // The processor reuses its meter frame object — clone on push or every
    // entry aliases the LAST frame (postMessage clones in the browser).
    this.posted.push(message && typeof message === "object" ? { ...(message as Record<string, unknown>) } : message);
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
  extras?: { key?: (i: number) => number; proc?: (proc: any) => void },
): Float32Array {
  const proc = new cls();
  extras?.proc?.(proc);
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

function goertzelAtRate(signal: Float32Array, hz: number, sampleRate: number, fromFrac = 0.6): number {
  const from = Math.floor(signal.length * fromFrac);
  const n = signal.length - from;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < signal.length; i++) {
    s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / Math.max(1, n);
}

function sineAt(hz: number, amp = 0.5): (i: number) => number {
  return (i) => amp * Math.sin((2 * Math.PI * hz * i) / SR);
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

/** Render a stereo corpus source, optionally at another host sample rate. */
function renderProcessorCorpus(
  cls: any,
  params: Record<string, Float32Array>,
  seconds: number,
  sampleAt: (i: number, sampleRate: number) => [number, number],
  sampleRate = SR,
): { L: Float32Array; R: Float32Array; proc: any } {
  const host = globalThis as unknown as { sampleRate: number };
  const previousRate = host.sampleRate;
  host.sampleRate = sampleRate;
  try {
    const proc = new cls();
    const total = Math.ceil(seconds * sampleRate);
    const outL = new Float32Array(total);
    const outR = new Float32Array(total);
    for (let offset = 0; offset < total; offset += BLOCK) {
      const len = Math.min(BLOCK, total - offset);
      const inputL = new Float32Array(len);
      const inputR = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const frame = sampleAt(offset + i, sampleRate);
        inputL[i] = frame[0];
        inputR[i] = frame[1];
      }
      const out = [new Float32Array(len), new Float32Array(len)];
      proc.process([[inputL, inputR]], [out], params);
      outL.set(out[0]!.subarray(0, len), offset);
      outR.set(out[1]!.subarray(0, len), offset);
    }
    return { L: outL, R: outR, proc };
  } finally {
    host.sampleRate = previousRate;
  }
}

function peakOf(signal: Float32Array): number {
  let peak = 0;
  for (const sample of signal) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

/** Render with per-block automated focusHz and/or hintHz (a-rate style values per sample). */
function renderProcessorAutomated(
  cls: any,
  base: Record<string, number>,
  seconds: number,
  input: (i: number) => number,
  focusAt?: (t: number) => number,
  hintAt?: (t: number) => number,
  onProc?: (proc: any) => void,
): Float32Array {
  const proc = new cls();
  onProc?.(proc);
  const total = Math.ceil(seconds * SR);
  const outAll = new Float32Array(total);
  for (let offset = 0; offset < total; offset += BLOCK) {
    const len = Math.min(BLOCK, total - offset);
    const params: Record<string, Float32Array> = {};
    for (const d of cls.parameterDescriptors as { name: string; defaultValue: number }[]) {
      const automate = d.name === "focusHz" ? focusAt : d.name === "hintHz" ? hintAt : undefined;
      params[d.name] = automate
        ? Float32Array.from({ length: len }, (_, i) => automate((offset + i) / SR))
        : Float32Array.from([base[d.name] ?? d.defaultValue]);
    }
    const inp = [Float32Array.from({ length: len }, (_, i) => input(offset + i))];
    const out = [new Float32Array(len), new Float32Array(len)];
    proc.process([inp], [out], params);
    outAll.set(out[0]!.subarray(0, len), offset);
  }
  return outAll;
}

/** Goertzel magnitude at `hz` over a fractional window of `signal`. */
function goertzelRange(signal: Float32Array, hz: number, fromFrac: number, toFrac: number): number {
  const from = Math.floor(signal.length * fromFrac);
  const to = Math.floor(signal.length * toFrac);
  const n = to - from;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

/** RBJ 2nd-order Butterworth highpass — the PHONE CHECK filter shape. */
function biquadHighpass(signal: Float32Array, freq: number): Float32Array {
  const w0 = (2 * Math.PI * freq) / SR;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = (1 + cos) / 2 / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(signal.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

/** RMS over the settled tail. */
function rmsAt(signal: Float32Array, fromFrac = 0.6): number {
  const from = Math.floor(signal.length * fromFrac);
  let sum = 0;
  for (let i = from; i < signal.length; i++) sum += signal[i]! * signal[i]!;
  return Math.sqrt(sum / (signal.length - from));
}

function sineAtPhase(hz: number, amp: number, phase: number): (i: number) => number {
  return (i) => amp * Math.sin((2 * Math.PI * hz * i) / SR + phase);
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

function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

describe("GROW registry contract", () => {
  it("registers on all surfaces with the declared params", () => {
    expect(EFFECT_DEFS.bassHarmonic.params).toEqual(EFFECT_META.bassHarmonic.params);
    expect(EFFECT_META.bassHarmonic.name).toBe("GROW");
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

describe("GROW processor behavior", () => {
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

describe("GROW wave-2 DSP (YIN tracker, phase coherence, deficit, CHARACTER)", () => {
  it("YIN stays on the true fundamental under a strong 2nd harmonic (no octave confusion)", () => {
    // The wave-1 zero-crossing estimator read this as 110 Hz and generated
    // 220/330; YIN's period-difference dip sits at 55 Hz (218 decimated
    // samples), so the 3rd harmonic lands at 165. The input's own 110 Hz
    // also exercises the deficit: the generated 2nd is suppressed.
    const cls = registered.get("bass-harmonic-processor");
    const params = paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 60, harmonics: 1, range: 2 });
    const out = renderProcessor(
      cls,
      params,
      1.5,
      (i) => 0.5 * Math.sin((2 * Math.PI * 55 * i) / SR) + 0.5 * Math.sin((2 * Math.PI * 110 * i) / SR),
    );
    const h3 = goertzelAt(out, 165);
    const wrongOctaveH3 = goertzelAt(out, 330);
    const h2 = goertzelAt(out, 110);
    expect(h3).toBeGreaterThan(0.1);
    expect(wrongOctaveH3).toBeLessThan(h3 * 0.05); // would be the 110-root's 3rd
    expect(h2).toBeLessThan(h3 * 0.1); // deficit: input already carries 110
  });

  it("generated harmonics stay phase-locked to the dry fundamental across input phases", () => {
    // With subAnchor 0 the output IS the generated layer. At every accepted
    // rising edge of the detection band the accumulators are nudged to 0
    // phase, so the 2nd harmonic's phase p must satisfy p = 2φ + c with the
    // same c for any input phase φ (c ≈ −2·atan(f0/300), the detection
    // filter's phase lag). A free-running generator cannot track φ at all.
    const cls = registered.get("bass-harmonic-processor");
    const params = paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1 });
    const offsets: number[] = [];
    for (const phi of [0, 0.35 * Math.PI, 0.8 * Math.PI]) {
      const out = renderProcessor(cls, params, 1.2, sineAtPhase(100, 0.5, phi));
      const locked = wrapPi(phaseAt(out, 200) - 2 * phi);
      offsets.push(locked);
      // Absolute lock: the filter-lag theory value −2·atan(100/300).
      expect(Math.abs(wrapPi(locked + 0.6435)), `phi=${phi}`).toBeLessThan(0.2);
    }
    for (let i = 1; i < offsets.length; i++) {
      expect(Math.abs(wrapPi(offsets[i]! - offsets[0]!)), `phase drift offset[${i}]`).toBeLessThan(0.1);
    }
  });

  it("deficit generation suppresses partials the input already carries", () => {
    // Pure 55 Hz → full generated 2nd (deficit 1). 55 + 110 at ratio 0.5 →
    // ratio above the 0.35 target, so the generated 2nd tapers to zero.
    const cls = registered.get("bass-harmonic-processor");
    const params = paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1 });
    const pure = renderProcessor(cls, params, 1.5, sineAt(55));
    const rich = renderProcessor(
      cls,
      params,
      1.5,
      (i) => 0.5 * Math.sin((2 * Math.PI * 55 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 110 * i) / SR),
    );
    const h2Pure = goertzelAt(pure, 110);
    const h2Rich = goertzelAt(rich, 110);
    expect(h2Pure).toBeGreaterThan(0.05);
    expect(h2Rich).toBeLessThan(h2Pure * 0.1);
  });

  it("CHARACTER SAT and FOLD add odd-harmonic energy the CLEAN curve does not", () => {
    const cls = registered.get("bass-harmonic-processor");
    const render = (character: number) =>
      renderProcessor(
        cls,
        paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1, character }),
        1.2,
        sineAt(55),
      );
    const clean = render(0);
    const sat = render(1);
    const fold = render(2);
    const clean3 = goertzelAt(clean, 330);
    const sat3 = goertzelAt(sat, 330);
    const fold3 = goertzelAt(fold, 330);
    expect(clean3).toBeLessThan(0.001); // pure 2nd stack
    expect(sat3).toBeGreaterThan(clean3 * 10);
    expect(fold3).toBeGreaterThan(clean3 * 10);
    // Both curves still generate the fundamental's 2nd (audible effect).
    expect(goertzelAt(sat, 110)).toBeGreaterThan(0.05);
    expect(goertzelAt(fold, 110)).toBeGreaterThan(0.05);
  });
});

describe("GROW tracker corpus and sample-rate safety", () => {
  const isolated = (cls: any) =>
    paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1, retrig: 0 });

  it("does not invent a pitch from silence or deterministic noise", () => {
    const cls = registered.get("bass-harmonic-processor");
    const silence = renderProcessorCorpus(cls, isolated(cls), 0.8, () => [0, 0]);
    const noise = renderProcessorCorpus(cls, isolated(cls), 0.8, (i) => {
      const bits = (Math.imul(i + 1, 1664525) + 1013904223) >>> 0;
      const sample = ((bits / 0xffffffff) * 2 - 1) * 0.5;
      return [sample, sample];
    });
    for (const result of [silence, noise]) {
      expect(peakOf(result.L)).toBeLessThan(1e-5);
      expect(result.proc.port.posted.at(-1)!.f0).toBe(0);
    }
  });

  it("rejects perfectly out-of-phase stereo bass instead of tracking the side signal", () => {
    const cls = registered.get("bass-harmonic-processor");
    const result = renderProcessorCorpus(cls, isolated(cls), 0.8, (i, rate) => {
      const sample = 0.5 * Math.sin((2 * Math.PI * 55 * i) / rate);
      return [sample, -sample];
    });
    expect(peakOf(result.L)).toBeLessThan(1e-5);
    expect(peakOf(result.R)).toBeLessThan(1e-5);
    expect(result.proc.port.posted.at(-1)!.f0).toBe(0);
  });

  it("settles back on the 808 root after a short kick transient", () => {
    const cls = registered.get("bass-harmonic-processor");
    const result = renderProcessorCorpus(cls, isolated(cls), 0.9, (i, rate) => {
      const t = i / rate;
      const bass = 0.45 * Math.sin(2 * Math.PI * 55 * t);
      const kick = t < 0.12 ? 0.65 * Math.exp(-t / 0.025) * Math.sin(2 * Math.PI * 95 * t) : 0;
      return [bass + kick, bass + kick];
    });
    const settled = result.proc.port.posted.at(-1)!;
    expect(settled.f0).toBeGreaterThan(54);
    expect(settled.f0).toBeLessThan(56);
  });

  it("releases a stale root and generated harmonics after the bass stops", () => {
    const cls = registered.get("bass-harmonic-processor");
    const result = renderProcessorCorpus(cls, isolated(cls), 0.8, (i, rate) => {
      const t = i / rate;
      const sample = t < 0.25 ? 0.5 * Math.sin((2 * Math.PI * 55 * i) / rate) : 0;
      return [sample, sample];
    });
    const settled = result.proc.port.posted.at(-1)!;
    const from = Math.floor(0.65 * SR);
    const tail = result.L.subarray(from);
    const tailRms = Math.sqrt(tail.reduce((sum, sample) => sum + sample * sample, 0) / tail.length);
    expect(settled.f0).toBe(0);
    expect(settled.clarity).toBe(0);
    expect(tailRms).toBeLessThan(0.002);
  });

  it("fades partials before Nyquist at an 8 kHz host sample rate", () => {
    const cls = registered.get("bass-harmonic-processor");
    const result = renderProcessorCorpus(
      cls,
      paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 220, range: 4, hintHz: 440 }),
      0.75,
      (i, rate) => {
        const sample = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
        return [sample, sample];
      },
      8000,
    );
    for (const sample of result.L) expect(Number.isFinite(sample)).toBe(true);
    expect(result.proc.port.posted.at(-1)!.f0).toBeCloseTo(440, 0);
    // The 10th partial (4.4 kHz) would fold to 3.6 kHz at 8 kHz. The
    // 0.42–0.48× Nyquist fade must remove that aliased component.
    expect(goertzelAtRate(result.L, 3600, 8000)).toBeLessThan(0.001);
  });

  it.each([44100, 48000, 96000])("tracks 55 Hz safely at %i Hz", (rate) => {
    const cls = registered.get("bass-harmonic-processor");
    const result = renderProcessorCorpus(
      cls,
      isolated(cls),
      0.65,
      (i, sampleRate) => {
        const sample = 0.5 * Math.sin((2 * Math.PI * 55 * i) / sampleRate);
        return [sample, sample];
      },
      rate,
    );
    for (const sample of result.L) expect(Number.isFinite(sample)).toBe(true);
    const tracked = result.proc.port.posted.at(-1)!.f0;
    expect(tracked).toBeGreaterThan(54);
    expect(tracked).toBeLessThan(56);
  });
});

describe("GROW wave-3 performance controls (SUSTAIN, RETRIG, WIDTH, focus automation)", () => {
  it("SUSTAIN compresses the generator envelope so quiet notes stay readable", () => {
    // A 0.06-amplitude note generates at 0.016 with the linear envelope;
    // the env^0.5 compression lifts the generated 2nd to ~0.085 (5×).
    const cls = registered.get("bass-harmonic-processor");
    const quiet = (i: number) => 0.06 * Math.sin((2 * Math.PI * 55 * i) / SR);
    const params = (sustain: number) =>
      paramsOf(cls, { drive: 0.7, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1, sustain });
    const off = renderProcessor(cls, params(0), 1.2, quiet);
    const on = renderProcessor(cls, params(1), 1.2, quiet);
    expect(goertzelAt(off, 110)).toBeGreaterThan(0.005);
    expect(goertzelAt(on, 110)).toBeGreaterThan(goertzelAt(off, 110) * 2.5);
  });

  it("RETRIG restarts the generated layer on note-ons (staccato note-on glue)", () => {
    // Two staccato sequences with different gaps (80 vs 130 ms). With the
    // reset, the post-onset-2 waveform restarts from the same phase state in
    // both runs, so the onset windows match; free-running, they diverge by
    // the gap-dependent phase.
    const cls = registered.get("bass-harmonic-processor");
    const sequence = (gap: number) => (i: number) => {
      const t = i / SR;
      if (t < 0.2) return 0.5 * Math.sin((2 * Math.PI * 55 * i) / SR);
      if (t >= 0.2 + gap && t < 0.2 + gap + 0.4) {
        const k = i - Math.round((0.2 + gap) * SR);
        return 0.5 * Math.sin((2 * Math.PI * 55 * k) / SR);
      }
      return 0;
    };
    const onsetRatio = (retrig: number): number => {
      const params = () =>
        paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1, retrig });
      const a = renderProcessorStereo(cls, params(), 0.2 + 0.08 + 0.4, sequence(0.08));
      const b = renderProcessorStereo(cls, params(), 0.2 + 0.13 + 0.4, sequence(0.13));
      const onA = Math.round((0.2 + 0.08 + 0.005) * SR);
      const onB = Math.round((0.2 + 0.13 + 0.005) * SR);
      const win = Math.round(0.04 * SR);
      let maxDiff = 0;
      let peak = 0;
      for (let k = 0; k < win; k++) {
        maxDiff = Math.max(maxDiff, Math.abs(a.L[onA + k]! - b.L[onB + k]!));
        peak = Math.max(peak, Math.abs(a.L[onA + k]!), Math.abs(b.L[onB + k]!));
      }
      return maxDiff / peak;
    };
    expect(onsetRatio(1)).toBeLessThan(0.5);
    expect(onsetRatio(0)).toBeGreaterThan(1.0);
  });

  it("WIDTH keeps the sub mono and rotates only the upper partials", () => {
    const cls = registered.get("bass-harmonic-processor");
    const base = { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 2 };
    const mono = renderProcessorStereo(cls, paramsOf(cls, { ...base, width: 0 }), 1.2, sineAt(55));
    expect(mono.L).toEqual(mono.R); // width 0 is the legacy bit-exact mono stack
    const wide = renderProcessorStereo(cls, paramsOf(cls, { ...base, width: 1 }), 1.2, sineAt(55));
    const side = Float32Array.from(wide.L, (v, i) => (v - wide.R[i]!) / 2);
    const sideLow = goertzelAt(side, 110); // 2nd partial = 110 Hz ≤ 120: mono
    const sideHigh = goertzelAt(side, 220); // 4th partial = 220 Hz: rotated
    expect(sideHigh).toBeGreaterThan(0.003);
    expect(sideLow).toBeLessThan(sideHigh * 0.05);
    const diffPhase = wrapPi(phaseAt(wide.L, 220) - phaseAt(wide.R, 220));
    expect(Math.abs(wrapPi(diffPhase - 1.2))).toBeLessThan(0.15); // ±φ = 2·0.6 rad
  });

  it("focusHz automation sweeps the tracking window (drop performance FX)", () => {
    // focus 40 (window 20–80) tracks the 55 Hz note; the automated ramp to
    // 220 (window 110–440) drops it out, so the generated 2nd mutes — the
    // sweep is pure native AudioParam automation, no extra DSP.
    const cls = registered.get("bass-harmonic-processor");
    const focusAt = (t: number) => (t < 0.5 ? 40 : t < 0.75 ? 40 * Math.pow(5.5, (t - 0.5) / 0.25) : 220);
    const out = renderProcessorAutomated(
      cls,
      { drive: 0.9, mix: 1, subAnchor: 0, harmonics: 0, range: 1 },
      1.2,
      sineAt(55),
      focusAt,
    );
    const early = goertzelRange(out, 110, 0.15, 0.45);
    const late = goertzelRange(out, 110, 0.9, 1.0);
    expect(early).toBeGreaterThan(0.05);
    expect(late).toBeLessThan(early * 0.05);
  });
});

describe("GROW wave-4 key modes (PUMP / DUCK)", () => {
  const keyBurst = (i: number) => {
    const t = i / SR;
    return t >= 0.5 && t < 0.7 ? 0.8 * Math.sin((2 * Math.PI * 60 * i) / SR) : 0;
  };
  const keyParams = (keyMode: number) =>
    paramsOf(registered.get("bass-harmonic-processor"), {
      drive: 0.9,
      mix: 1,
      subAnchor: 0,
      focusHz: 90,
      harmonics: 0,
      range: 1,
      keyMode,
    });

  it("PUMP blooms the generated harmonics on the key hit; DUCK pulls them down", () => {
    const cls = registered.get("bass-harmonic-processor");
    const pre = (sig: Float32Array) => goertzelRange(sig, 110, 0.3, 0.45);
    const during = (sig: Float32Array) => goertzelRange(sig, 110, 0.55, 0.68);
    const off = renderProcessor(cls, keyParams(0), 1.0, sineAt(55), { key: keyBurst });
    const pump = renderProcessor(cls, keyParams(1), 1.0, sineAt(55), { key: keyBurst });
    const duck = renderProcessor(cls, keyParams(2), 1.0, sineAt(55), { key: keyBurst });
    // OFF ignores the key entirely — bit-identical output.
    const plain = renderProcessor(cls, keyParams(0), 1.0, sineAt(55));
    expect(off).toEqual(plain);
    // PUMP: up to ×2 on the generated layer (energy ratio ~2, attack lag).
    expect(pre(pump)).toBeGreaterThan(0.05);
    expect(during(pump) / pre(pump)).toBeGreaterThan(1.3);
    // DUCK: down to ×0.15 (energy ratio deep below 1).
    expect(during(duck) / pre(duck)).toBeLessThan(0.5);
  });

  it("key mode without a key feed is a bit-exact no-op (PUMP and DUCK)", () => {
    const cls = registered.get("bass-harmonic-processor");
    const plain = renderProcessor(cls, keyParams(0), 1.0, sineAt(55));
    expect(renderProcessor(cls, keyParams(1), 1.0, sineAt(55))).toEqual(plain);
    expect(renderProcessor(cls, keyParams(2), 1.0, sineAt(55))).toEqual(plain);
  });

  it("posts a throttled koren telemetry frame with f0, clarity, boost and partials", () => {
    const cls = registered.get("bass-harmonic-processor");
    let proc: any = null;
    renderProcessor(cls, paramsOf(cls, { drive: 0.9, mix: 1 }), 1.0, sineAt(55), { proc: (p) => (proc = p) });
    const posts = proc.port.posted as {
      type: string;
      f0: number;
      clarity: number;
      harm: number;
      key: number;
      partials: Float32Array;
    }[];
    expect(posts.length).toBeGreaterThanOrEqual(15); // ~20 Hz over 1 s
    expect(posts.length).toBeLessThanOrEqual(25);
    for (const frame of posts) expect(frame.type).toBe("koren");
    const settled = posts.at(-1)!;
    expect(settled.f0).toBeGreaterThan(54);
    expect(settled.f0).toBeLessThan(56);
    expect(settled.clarity).toBeGreaterThan(0.8);
    expect(settled.harm).toBeGreaterThan(6); // pure sine = full harmonic deficit
    expect(settled.key).toBe(1);
    expect(settled.partials.length).toBe(15); // harmonics 2..16
    expect(settled.partials[0]).toBeGreaterThan(0.05); // the generated 2nd
  });
});

describe("GROW node wrapper (key input + telemetry cache)", () => {
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

  const makeSource = (calls: string[]): AudioNode =>
    ({
      connect: (_target: unknown, output?: number, input?: number) => calls.push(`connect:${output}:${input}`),
      disconnect: (_target: unknown, output?: number, input?: number) => calls.push(`disconnect:${output}:${input}`),
    }) as unknown as AudioNode;

  beforeAll(() => {
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
  });

  it("creates a 2-input node and wires/detaches the key with identical-repoint no-ops", () => {
    const runtime = createBassHarmonicNode(makeCtx(), { params: { drive: 0.5 } });
    const node = FakeWorkletNode.instances.at(-1)!;
    expect((node.options as { numberOfInputs: number }).numberOfInputs).toBe(2);
    const calls: string[] = [];
    const source = makeSource(calls);
    runtime.setSidechainInput!(source);
    expect(calls).toEqual(["connect:0:1"]);
    runtime.setSidechainInput!(source); // engine re-asserts on every sync
    expect(calls).toEqual(["connect:0:1"]);
    const replacement = makeSource(calls);
    runtime.setSidechainInput!(replacement);
    expect(calls).toEqual(["connect:0:1", "disconnect:0:1", "connect:0:1"]);
    runtime.setSidechainInput!(null);
    expect(calls.at(-1)).toBe("disconnect:0:1");
    runtime.dispose();
    runtime.dispose(); // idempotent
  });

  it("caches only validated koren frames for getMeters", () => {
    const runtime = createBassHarmonicNode(makeCtx(), { params: {} });
    const node = FakeWorkletNode.instances.at(-1)!;
    expect(runtime.getMeters!()).toBeNull();
    node.port.onmessage!({
      data: { type: "koren", f0: 55.2, clarity: 0.95, harm: 12.5, key: 1, partials: new Float32Array(9) },
    });
    const frame = runtime.getMeters!() as KorenMeterFrame;
    expect(frame.f0).toBe(55.2);
    expect(frame.harm).toBe(12.5);
    expect(frame.partials).toBeInstanceOf(Float32Array);
    // Shape violations and foreign messages never replace the cached frame.
    node.port.onmessage!({ data: { type: "koren", f0: Number.NaN, clarity: 1, harm: 1, key: 1 } });
    node.port.onmessage!({ data: { type: "other", f0: 1, clarity: 1, harm: 1, key: 1 } });
    node.port.onmessage!({ data: null });
    expect(runtime.getMeters!()).toBe(frame);
    runtime.dispose();
    expect(runtime.getMeters!()).toBeNull();
  });
});

describe("KOREŇ wave-7 glide tracking (accepted-crossing refinement)", () => {
  const F0 = 55;
  const F1 = 75;
  const T = 0.5;
  const R = F1 / F0;
  const trueF = (t: number) => (t < T ? F0 * Math.pow(R, t / T) : F1);
  const glideInput = (i: number) => {
    const t = i / SR;
    const phase =
      t < T
        ? 2 * Math.PI * F0 * ((Math.pow(R, t / T) - 1) * (T / Math.log(R)))
        : 2 * Math.PI * F0 * ((R - 1) * (T / Math.log(R))) + 2 * Math.PI * F1 * (t - T);
    return 0.5 * Math.sin(phase);
  };

  it("follows an exponential pitch sweep within a few percent (refinement owns the glide)", () => {
    const cls = registered.get("bass-harmonic-processor");
    let proc: any = null;
    renderProcessor(
      cls,
      paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1 }),
      1.2,
      glideInput,
      { proc: (p) => (proc = p) },
    );
    const frames = proc.port.posted as { type: string; f0: number }[];
    // Meter frames land every 2432 samples (19 blocks) at 48 kHz.
    const errors = frames
      .map((frame, index) => ({ t: ((index + 1) * 2432) / SR, f0: frame.f0 }))
      .filter(({ t, f0 }) => t > 0.15 && t < 0.5 && f0 > 0)
      .map(({ t, f0 }) => Math.abs(f0 - trueF(t)) / trueF(t));
    expect(errors.length).toBeGreaterThan(5);
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const max = Math.max(...errors);
    // The pre-refinement baseline measured 5.1 % mean / 5.4 % max on this sweep.
    expect(mean, `mean glide error ${(mean * 100).toFixed(1)} %`).toBeLessThan(0.03);
    expect(max, `max glide error ${(max * 100).toFixed(1)} %`).toBeLessThan(0.04);
  });

  it("harmonic-rich input still settles on the true root (refinement never yanks it)", () => {
    // 55 Hz + a strong 3rd (165) puts extra rising edges in the detection
    // band; the plausibility clamp must reject those intervals instead of
    // reporting a harmonic multiple of the root.
    const cls = registered.get("bass-harmonic-processor");
    let proc: any = null;
    renderProcessor(
      cls,
      paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1 }),
      1.2,
      (i) => 0.5 * Math.sin((2 * Math.PI * 55 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 165 * i) / SR),
      { proc: (p) => (proc = p) },
    );
    const settled = (proc.port.posted as { f0: number }[]).at(-1)!;
    expect(settled.f0).toBeGreaterThan(54.5);
    expect(settled.f0).toBeLessThan(55.5);
  });
});

describe("KOREŇ wave-8 engine pitch hint (hintHz)", () => {
  const base = { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0, range: 1 };

  it("a hint snaps the root with zero acquisition latency", () => {
    // Without the hint the untracked gate holds generation off until YIN
    // locks (~90 ms); the hint is exact knowledge, so the attack generates
    // from the first envelope rise onward.
    const cls = registered.get("bass-harmonic-processor");
    const noHint = renderProcessor(cls, paramsOf(cls, base), 1.0, sineAt(55));
    const hinted = renderProcessor(cls, paramsOf(cls, { ...base, hintHz: 55 }), 1.0, sineAt(55));
    const earlyNo = goertzelRange(noHint, 110, 0.02, 0.06);
    const earlyYes = goertzelRange(hinted, 110, 0.02, 0.06);
    expect(earlyNo).toBeLessThan(0.002);
    expect(earlyYes).toBeGreaterThan(0.05);
    expect(earlyYes).toBeGreaterThan(earlyNo * 10);
    // Already near the settled level — no ramp-in wait.
    expect(earlyYes).toBeLessThan(goertzelRange(hinted, 110, 0.9, 1.0) * 2);
  });

  it("hint automation glides the tracked root (MIDI glide)", () => {
    const cls = registered.get("bass-harmonic-processor");
    const F0 = 55;
    const F1 = 75;
    const T = 0.5;
    const R = F1 / F0;
    const trueF = (t: number) => (t < T ? F0 * Math.pow(R, t / T) : F1);
    const glideInput = (i: number) => {
      const t = i / SR;
      const phase =
        t < T
          ? 2 * Math.PI * F0 * ((Math.pow(R, t / T) - 1) * (T / Math.log(R)))
          : 2 * Math.PI * F0 * ((R - 1) * (T / Math.log(R))) + 2 * Math.PI * F1 * (t - T);
      return 0.5 * Math.sin(phase);
    };
    const hintAt = (t: number) => (t < T ? F0 * Math.pow(R, Math.min(t, T) / T) : F1);
    let proc: any = null;
    renderProcessorAutomated(cls, base, 0.8, glideInput, undefined, hintAt, (p) => (proc = p));
    const errors = (proc.port.posted as { f0: number }[])
      .map((frame, index) => ({ t: ((index + 1) * 2432) / SR, f0: frame.f0 }))
      .filter(({ t, f0 }) => t > 0.05 && t < 0.7 && f0 > 0)
      .map(({ t, f0 }) => Math.abs(f0 - trueF(t)) / trueF(t));
    expect(errors.length).toBeGreaterThan(8);
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    // The hint IS the note timeline: the tracker must ride it almost exactly.
    expect(mean, `mean hint-glide error ${(mean * 100).toFixed(2)} %`).toBeLessThan(0.01);
    expect(Math.max(...errors)).toBeLessThan(0.02);
  });

  it("an untrackable two-tone input still generates at the hinted root", () => {
    // 55 + 82.4 Hz defeats the YIN clarity gate; the hint keeps generation
    // legitimate — and the deficit stays honest (no 110 Hz in the input, so
    // the 2nd is generated, not suppressed).
    const cls = registered.get("bass-harmonic-processor");
    const twoTone = (i: number) =>
      0.5 * Math.sin((2 * Math.PI * 55 * i) / SR) + 0.4 * Math.sin((2 * Math.PI * 82.4 * i) / SR);
    const noHint = renderProcessor(cls, paramsOf(cls, base), 1.2, twoTone);
    const hinted = renderProcessor(cls, paramsOf(cls, { ...base, hintHz: 55 }), 1.2, twoTone);
    const hNo = goertzelRange(noHint, 110, 0.6, 1.0);
    const hYes = goertzelRange(hinted, 110, 0.6, 1.0);
    expect(hYes).toBeGreaterThan(0.02);
    expect(hNo).toBeLessThan(hYes * 0.25);
  });

  it("hint clears back to pure YIN (note-off fallback), no gap", () => {
    const cls = registered.get("bass-harmonic-processor");
    const out = renderProcessorAutomated(cls, base, 1.2, sineAt(55), undefined, (t) => (t < 0.5 ? 55 : 0));
    expect(goertzelRange(out, 110, 0.6, 0.9)).toBeGreaterThan(0.1);
  });
});

describe("GROW wave-6 presence band (phone readability)", () => {
  it("PRESENCE redistributes the stack into the phone band (≥385 Hz at f0 = 55)", () => {
    // range 4 → 16 partials: 55 Hz × 7..16 = 385–880 Hz, inside a phone
    // speaker's usable band. presence lifts that band >3× while the 2nd
    // gives way; with the sub anchor in place the total output level is
    // unchanged (the redistribution is inside the generated layer).
    const cls = registered.get("bass-harmonic-processor");
    const render = (presence: number) =>
      renderProcessor(
        cls,
        paramsOf(cls, { drive: 0.9, mix: 1, subAnchor: 0.8, focusHz: 90, harmonics: 0.5, range: 4, presence }),
        1.5,
        sineAt(55),
      );
    const bandEnergy = (out: Float32Array) => {
      let acc = 0;
      for (let n = 7; n <= 16; n++) acc += goertzelAt(out, n * 55) ** 2;
      return Math.sqrt(acc);
    };
    const off = render(0);
    const on = render(1);
    expect(bandEnergy(on)).toBeGreaterThan(bandEnergy(off) * 2.5);
    expect(goertzelAt(on, 110)).toBeLessThan(goertzelAt(off, 110));
    // Redistribution, not a level change: full-band RMS within ±25 %.
    expect(rmsAt(on)).toBeGreaterThan(rmsAt(off) * 0.75);
    expect(rmsAt(on)).toBeLessThan(rmsAt(off) * 1.25);
  });

  it("through a 350 Hz phone-check highpass, PRESENCE nearly doubles the audible energy", () => {
    // The 808-phone recipe: the legacy stack (2nd/3rd at 110–220 Hz) sits
    // under the phone check's highpass; presence puts the energy where a
    // phone speaker reproduces. Dry = mix 0 (bit-exact passthrough).
    const cls = registered.get("bass-harmonic-processor");
    const preset = {
      drive: 0.7,
      focusHz: 70,
      harmonics: 0.4,
      subAnchor: 0.8,
      lowCut: 45,
      range: 4,
      sustain: 0.45,
      mix: 0.65,
    };
    const render = (presence: number, mix = 0.65) =>
      renderProcessor(cls, paramsOf(cls, { ...preset, presence, mix }), 1.5, sineAt(55));
    const dry = rmsAt(biquadHighpass(render(1, 0), 350));
    const legacy = rmsAt(biquadHighpass(render(0), 350));
    const presence = rmsAt(biquadHighpass(render(1), 350));
    expect(presence).toBeGreaterThan(dry * 2.5); // the effect earns its keep
    expect(presence).toBeGreaterThan(legacy * 1.4); // presence is the fix
  });
});

describe("GROW wave-9 phase/tilt profiles (timbre, same spectrum)", () => {
  const base = { drive: 0.9, mix: 1, subAnchor: 0, focusHz: 90, harmonics: 0.5, range: 4, presence: 1 };
  const crest = (sig: Float32Array) => {
    let peak = 0;
    const from = Math.floor(sig.length * 0.6);
    for (let i = from; i < sig.length; i++) peak = Math.max(peak, Math.abs(sig[i]!));
    return peak / Math.max(rmsAt(sig), 1e-9);
  };

  it("PHASE collapses the presence-band crest at identical spectrum and RMS", () => {
    // With the presence band active the stack has ~7 comparable partials in
    // 385–880 Hz — the aligned (legacy) waveform crests at ~11.4 dB while the
    // Schroeder phases spread the zero crossings and crest ~5.6 dB: same
    // energy, same spectrum, a smoother waveform that fits more level.
    const cls = registered.get("bass-harmonic-processor");
    const p0 = renderProcessor(cls, paramsOf(cls, { ...base, phase: 0 }), 1.5, sineAt(55));
    const p5 = renderProcessor(cls, paramsOf(cls, { ...base, phase: 0.5 }), 1.5, sineAt(55));
    const p1 = renderProcessor(cls, paramsOf(cls, { ...base, phase: 1 }), 1.5, sineAt(55));
    expect(crest(p0)).toBeGreaterThan(crest(p1) * 1.6);
    expect(crest(p5)).toBeLessThan(crest(p0));
    expect(crest(p5)).toBeGreaterThan(crest(p1));
    // Same energy and spectrum — only the waveform's time shape changes.
    expect(rmsAt(p1)).toBeCloseTo(rmsAt(p0), 2);
    for (const hz of [110, 165, 220, 385, 440]) {
      expect(goertzelAt(p1, hz)).toBeCloseTo(goertzelAt(p0, hz), 3);
    }
  });

  it("TILT redistributes the stack: saw-like up, darker down", () => {
    const cls = registered.get("bass-harmonic-processor");
    const hiBand = (sig: Float32Array) => {
      let acc = 0;
      for (let n = 7; n <= 16; n++) acc += goertzelAt(sig, n * 55) ** 2;
      return Math.sqrt(acc);
    };
    const down = renderProcessor(cls, paramsOf(cls, { ...base, presence: 0, tilt: -1 }), 1.5, sineAt(55));
    const mid = renderProcessor(cls, paramsOf(cls, { ...base, presence: 0, tilt: 0 }), 1.5, sineAt(55));
    const up = renderProcessor(cls, paramsOf(cls, { ...base, presence: 0, tilt: 1 }), 1.5, sineAt(55));
    expect(hiBand(up)).toBeGreaterThan(hiBand(mid) * 1.8);
    expect(hiBand(down)).toBeLessThan(hiBand(mid) * 0.6);
    expect(goertzelAt(up, 110)).toBeLessThan(goertzelAt(mid, 110));
    expect(goertzelAt(down, 110)).toBeGreaterThan(goertzelAt(mid, 110));
  });
});

describe("GROW factory preset adoption (wave-9 axes)", () => {
  it("the preset bank carries the adopted phase/tilt characters", () => {
    const byId = new Map(CORE_EFFECT_PRESETS.map((preset) => [preset.id, preset]));
    // 808 Phone rides the crest-reduced phase profile for phone level.
    expect(byId.get("bassharmonic-808-phone")!.params.phase).toBeGreaterThan(0.2);
    // Club Sub deliberately stays the legacy aligned reference.
    expect(byId.get("bassharmonic-club-sub")!.params.phase ?? 0).toBe(0);
    expect(byId.get("bassharmonic-club-sub")!.params.tilt ?? 0).toBe(0);
    // Drill Growl leans saw-like (buzzier tail) through FOLD.
    expect(byId.get("bassharmonic-drill-growl")!.params.tilt).toBeGreaterThan(0.2);
    // Subtle Body is smooth and round: high phase, negative tilt.
    expect(byId.get("bassharmonic-subtle-body")!.params.phase).toBeGreaterThan(0.4);
    expect(byId.get("bassharmonic-subtle-body")!.params.tilt).toBeLessThan(0);
  });
});
