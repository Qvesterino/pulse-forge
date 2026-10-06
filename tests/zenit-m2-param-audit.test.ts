import { beforeEach, describe, expect, it, vi } from "vitest";
import { EFFECT_DEFS, defaultParamsOf, limitThreshold } from "../src/effects/registry";
import { apeksParams, prudParams, sirkaParams } from "../src/effects/definitions";
import type { EffectInstance } from "../src/project-model/types";
import type { EffectRuntime } from "../src/effects/types";
import { zenitParams } from "../src/effects/definitions";

/**
 * PARAM AUDIT — ZENIT (9 macros) + the M2 worklet processors (APEKS 6,
 * ŠÍRKA 6, PRÚD 11), per docs/NEW-EFFECT-CHECKLIST.md #13: min AND max must
 * move a measured metric — "peak > 0" proved nothing when phaser's wet chain
 * was silent. Three layers are pinned here:
 *
 *   A. ZENIT macro → stage-param mapping (spy on the stage factories), for
 *      every macro at BOTH extremes, plus the ceiling↔limit state coupling
 *      (a ceiling move must re-derive the limiter threshold, load-order
 *      independent).
 *   B. Definition ranges match the processor parameterDescriptors (a name or
 *      range drift is death mode #3 in the making).
 *   C. Every M2 param is ALIVE: processor run at param min vs max on a
 *      designed excitation must differ measurably (max |a[i] − b[i]|).
 */

type Write = { id: string; value: number; when?: number };

function recordingRuntime(): { rt: EffectRuntime; writes: Write[] } {
  const writes: Write[] = [];
  const rt: EffectRuntime = {
    input: { connect: () => undefined } as unknown as GainNode,
    output: { connect: () => undefined } as unknown as GainNode,
    setParameter: (id, value) => writes.push({ id, value }),
    setParameterAt: (id, value, when) => writes.push({ id, value, when }),
    dispose() {},
  };
  return { rt, writes };
}

const STAGE_KEYS = {
  eq: "eq",
  tapeSat: "tape",
  compressor: "comp",
  utility: "util",
  clipper: "clip",
  limiter: "lim",
} as const;
type StageKey = (typeof STAGE_KEYS)[keyof typeof STAGE_KEYS];

function spyStages(): Record<StageKey, Write[]> {
  const out = {} as Record<StageKey, Write[]>;
  for (const [type, key] of Object.entries(STAGE_KEYS) as Array<[keyof typeof STAGE_KEYS, StageKey]>) {
    const { rt, writes } = recordingRuntime();
    out[key] = writes;
    vi.spyOn(EFFECT_DEFS[type], "factory").mockReturnValue(rt);
  }
  return out;
}

function buildZenit(params: Record<string, number>): EffectRuntime {
  const instance = { id: "zenit-audit", type: "zenit", bypassed: false, params } as EffectInstance;
  return EFFECT_DEFS.zenit.factory({} as unknown as BaseAudioContext, instance, { bpm: 120 });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ZENIT macro → stage mapping (both extremes, checklist #13)", () => {
  it("EQ macros land on the three shelf gains", () => {
    const writes = spyStages();
    const rt = buildZenit({ eqLow: -6, eqMid: 6, eqHigh: -6 });
    expect(writes.eq).toContainEqual({ id: "lowShelfGain", value: -6 });
    expect(writes.eq).toContainEqual({ id: "lowMidGain", value: 6 });
    expect(writes.eq).toContainEqual({ id: "highShelfGain", value: -6 });
    rt.setParameter("eqLow", 6);
    rt.setParameter("eqMid", -6);
    rt.setParameter("eqHigh", 6);
    expect(writes.eq).toContainEqual({ id: "lowShelfGain", value: 6 });
    expect(writes.eq).toContainEqual({ id: "lowMidGain", value: -6 });
    expect(writes.eq).toContainEqual({ id: "highShelfGain", value: 6 });
    rt.dispose();
  });

  it("GLUE opens the comp and sweeps threshold+ratio; 0 closes it", () => {
    const writes = spyStages();
    const rt = buildZenit({ glue: 1 });
    expect(writes.comp).toContainEqual({ id: "mix", value: 1 });
    expect(writes.comp).toContainEqual({ id: "threshold", value: -6 - 18 });
    expect(writes.comp).toContainEqual({ id: "ratio", value: 1.4 + 2.1 });
    rt.setParameter("glue", 0);
    expect(writes.comp.at(-1)).toEqual({ id: "mix", value: 0 });
    rt.dispose();
  });

  it("DRIVE opens the tape stage; WIDTH spans the full 0..2 M/S range; BASS MONO reaches the mono maker", () => {
    const writes = spyStages();
    const rt = buildZenit({ drive: 1, width: 2, bassMono: 200 });
    expect(writes.tape).toContainEqual({ id: "drive", value: 1 });
    expect(writes.tape).toContainEqual({ id: "mix", value: 1 });
    expect(writes.util).toContainEqual({ id: "width", value: 2 }); // utility runtime clamps at 2, not 1
    expect(writes.util).toContainEqual({ id: "monoBassFrequency", value: 200 });
    rt.setParameter("drive", 0);
    rt.setParameter("width", 0);
    rt.setParameter("bassMono", 0);
    expect(writes.tape).toContainEqual({ id: "mix", value: 0 });
    expect(writes.util).toContainEqual({ id: "width", value: 0 });
    expect(writes.util).toContainEqual({ id: "monoBassFrequency", value: 0 }); // OFF
    rt.dispose();
  });

  it("CEILING reaches clipper AND limiter; LIMIT derives the threshold from the ceiling", () => {
    const writes = spyStages();
    const rt = buildZenit({ ceiling: 0, limit: 1 });
    expect(writes.clip).toContainEqual({ id: "ceiling", value: 0 });
    expect(writes.lim).toContainEqual({ id: "ceiling", value: 0 });
    expect(writes.lim).toContainEqual({ id: "threshold", value: limitThreshold(1, 0) });
    rt.setParameter("ceiling", -6);
    rt.setParameter("limit", 0);
    expect(writes.lim).toContainEqual({ id: "ceiling", value: -6 });
    expect(writes.lim).toContainEqual({ id: "threshold", value: limitThreshold(1, -6) }); // re-derived on ceiling move
    expect(writes.lim).toContainEqual({ id: "threshold", value: limitThreshold(0, -6) }); // idle at the new ceiling
    rt.dispose();
  });

  it("ceiling↔limit coupling is load-order independent (param object iteration order)", () => {
    const a = spyStages();
    const rtA = buildZenit({ limit: 0.5, ceiling: -3 });
    expect(a.lim.filter((w) => w.id === "threshold").at(-1)?.value).toBeCloseTo(limitThreshold(0.5, -3), 9);
    rtA.dispose();
    const b = spyStages();
    const rtB = buildZenit({ ceiling: -3, limit: 0.5 });
    expect(b.lim.filter((w) => w.id === "threshold").at(-1)?.value).toBeCloseTo(limitThreshold(0.5, -3), 9);
    rtB.dispose();
  });
});

describe("M2 definition ranges match the processor parameterDescriptors", () => {
  it("APEKS: same ids and clamps on both sides of the port", async () => {
    const cls = await processorClass("apeks-processor");
    compareRanges(apeksParams, cls.parameterDescriptors);
  });

  it("ŠÍRKA: same ids and clamps on both sides of the port", async () => {
    const cls = await processorClass("sirka-processor");
    compareRanges(sirkaParams, cls.parameterDescriptors);
  });

  it("PRÚD: same ids and clamps on both sides of the port", async () => {
    const cls = await processorClass("prud-processor");
    compareRanges(prudParams, cls.parameterDescriptors);
  });

  async function processorClass(name: string): Promise<{
    parameterDescriptors: Array<{ name: string; minValue: number; maxValue: number; defaultValue: number }>;
  }> {
    await bootProcessors();
    const cls = registered.get(name);
    expect(cls, name).toBeDefined();
    return cls;
  }

  function compareRanges(
    defs: Array<{ id: string; min: number; max: number; default: number }>,
    descriptors: Array<{ name: string; minValue: number; maxValue: number; defaultValue: number }>,
  ) {
    expect(descriptors.map((d) => d.name)).toEqual(defs.map((d) => d.id));
    for (const def of defs) {
      const d = descriptors.find((x) => x.name === def.id)!;
      expect(d.minValue, `${def.id} min`).toBe(def.min);
      expect(d.maxValue, `${def.id} max`).toBe(def.max);
      expect(d.defaultValue, `${def.id} default`).toBe(def.default);
    }
  }
});

// ── processor boot harness (same pattern as tests/m2-dsp.test.ts) ──

const registered = new Map<string, any>();
let booted = false;

async function bootProcessors(): Promise<void> {
  if (booted) return;
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage() {} };
  };
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (
    name: string,
    cls: new () => unknown,
  ) => {
    registered.set(name, cls);
  };
  await import("../src/audio-worklets/apeks-processor.js");
  await import("../src/audio-worklets/sirka-processor.js");
  await import("../src/audio-worklets/prud-processor.js");
  booted = true;
}

const SR = 48000;
const BLOCK = 128;

function paramRecord(cls: any, overrides: Record<string, number>): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const d of cls.parameterDescriptors as Array<{ name: string; defaultValue: number }>) {
    out[d.name] = Float32Array.of(overrides[d.name] ?? d.defaultValue);
  }
  return out;
}

/** Run the processor over `blocks` blocks; returns the concatenated output L channel. */
function runProcessor(
  cls: any,
  overrides: Record<string, number>,
  input: (i: number) => [number, number],
  blocks: number,
): Float32Array {
  const proc = new cls();
  const params = paramRecord(cls, overrides);
  const all: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const inp = [
      Float32Array.from({ length: BLOCK }, (_, i) => input(b * BLOCK + i)[0]),
      Float32Array.from({ length: BLOCK }, (_, i) => input(b * BLOCK + i)[1]),
    ];
    const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    proc.process([inp], [out], params);
    for (let i = 0; i < BLOCK; i++) all.push(out[0]![i]!);
  }
  return Float32Array.from(all);
}

function maxDelta(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/** Deterministic LCG noise so sweeps compare like for like. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const ALIVE = 1e-3;

describe("M2 per-param aliveness (min vs max must move the output)", () => {
  const bursts = (i: number): [number, number] => {
    // 0.5 s bursts of loud signal with per-sample L/R difference.
    const phase = i % 24000;
    const on = phase < 12000 ? 1 : 0.05;
    const t = i / SR;
    return [0.85 * on * Math.sin(2 * Math.PI * 220 * t), 0.8 * on * Math.sin(2 * Math.PI * 220 * t + 0.4)];
  };

  it("APEKS: all six params alive", async () => {
    await bootProcessors();
    const cls = registered.get("apeks-processor");
    // PRESERVE has a structurally NARROW audible window (probe-measured
    // 10-06): the transient share only differs from the sustain share while
    // the fast/slow envelopes disagree, and the ceiling guard clamps exactly
    // the loud-tip region where (1-gr) is large. Best measured delta across
    // six excitation families: ~6e-4 — alive, but far below the 0-100%
    // panel range's implication; flagged as a design question for the owner
    // (docs/HONEST-GATE-AUDIT M2 section), not silently redesigned here.
    const padAndBurst = (i: number): [number, number] => {
      const t = i / SR;
      const pad = 0.8 * Math.sin(2 * Math.PI * 110 * t);
      const phase = i % 6000;
      const burst = phase < 240 ? 0.2 * (1 - phase / 240) : 0;
      return [pad + burst, pad * 0.95 + burst];
    };
    const cases: Array<[string, number, number, (i: number) => [number, number], Record<string, number>, number]> = [
      ["drive", 0, 1, bursts, {}, ALIVE],
      ["ceiling", -12, 0, bursts, {}, ALIVE],
      ["release", 0.05, 0.5, bursts, {}, ALIVE],
      ["preserve", 0, 1, padAndBurst, { drive: 0.35 }, 1e-4],
      ["mix", 0, 1, bursts, {}, ALIVE],
      ["output", -12, 12, bursts, {}, ALIVE],
    ];
    for (const [id, min, max, input, fix, threshold] of cases) {
      const a = runProcessor(cls, { ...fix, [id]: min }, input, 96);
      const b = runProcessor(cls, { ...fix, [id]: max }, input, 96);
      expect(maxDelta(a, b), `APEKS ${id} min ${min} vs max ${max}`).toBeGreaterThan(threshold);
    }
  });

  it("ŠÍRKA: all six params alive (splits measured with non-neutral widths)", async () => {
    await bootProcessors();
    const cls = registered.get("sirka-processor");
    const noise = lcg(4242);
    const wide = (): [number, number] => [noise() * 0.8 - 0.4, noise() * 0.8 - 0.4];
    // Split-freq params only matter when widths ≠ 1 — pin them non-neutral.
    const splitFix = { lowWidth: 0.2, midWidth: 2, highWidth: 1.5 };
    const cases: Array<[string, number, number, Record<string, number>]> = [
      ["lowFreq", 60, 500, splitFix],
      ["highFreq", 2000, 12000, splitFix],
      ["lowWidth", 0, 2, {}],
      ["midWidth", 0, 2, {}],
      ["highWidth", 0, 2, {}],
      ["mix", 0, 1, {}],
    ];
    for (const [id, min, max, fix] of cases) {
      const a = runProcessor(cls, { ...fix, [id]: min }, wide, 64);
      const b = runProcessor(cls, { ...fix, [id]: max }, wide, 64);
      expect(maxDelta(a, b), `ŠÍRKA ${id} min ${min} vs max ${max}`).toBeGreaterThan(ALIVE);
    }
  });

  it("PRÚD: all eleven params alive", async () => {
    await bootProcessors();
    const cls = registered.get("prud-processor");
    // Two tones inside the default bands (700 Hz in band 1, 4.5 kHz in band 2),
    // burst-gated so attack/release show in the full-buffer delta.
    const tone = (i: number): [number, number] => {
      const on = i % 24000 < 12000 ? 1 : 0.02;
      const t = i / SR;
      const v = 0.6 * Math.sin(2 * Math.PI * 700 * t) + 0.5 * Math.sin(2 * Math.PI * 4500 * t);
      return [v * on, v * 0.95 * on];
    };
    const cases: Array<[string, number, number]> = [
      ["freq1", 80, 8000],
      ["thresh1", -60, 0],
      ["amount1", -12, 0],
      ["q1", 0.5, 8],
      ["freq2", 80, 12000],
      ["thresh2", -60, 0],
      ["amount2", -12, 0],
      ["q2", 0.5, 8],
      ["attack", 0.001, 0.1],
      ["release", 0.01, 1],
      ["output", -12, 12],
    ];
    for (const [id, min, max] of cases) {
      const a = runProcessor(cls, { [id]: min }, tone, 96);
      const b = runProcessor(cls, { [id]: max }, tone, 96);
      expect(maxDelta(a, b), `PRÚD ${id} min ${min} vs max ${max}`).toBeGreaterThan(ALIVE);
    }
  });

  it("defaults render finite and the ZENIT macro surface matches its stage map (catalog contract)", () => {
    for (const def of [...zenitParams, ...apeksParams, ...sirkaParams, ...prudParams]) {
      expect(Number.isFinite(def.min), `${def.id} min`).toBe(true);
      expect(Number.isFinite(def.max), `${def.id} max`).toBe(true);
      expect(Number.isFinite(def.default), `${def.id} default`).toBe(true);
      expect(def.min).toBeLessThanOrEqual(def.default);
      expect(def.default).toBeLessThanOrEqual(def.max);
    }
    // Defaults exist for every macro (defaultParamsOf must not throw).
    expect(() => defaultParamsOf("zenit")).not.toThrow();
    expect(() => defaultParamsOf("prud")).not.toThrow();
  });
});
