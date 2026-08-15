import { describe, expect, it } from "vitest";
import {
  EFFECT_DEFS,
  EFFECT_ORDER,
  PUMP_DIVISIONS,
  clampEffectParam,
  defaultParamsOf,
  duckCurve,
} from "../src/effects/registry";
import type { EffectType } from "../src/project-model/types";

describe("effect registry", () => {
  it("EFFECT_ORDER covers every definition", () => {
    expect(new Set(EFFECT_ORDER)).toEqual(new Set(Object.keys(EFFECT_DEFS) as EffectType[]));
  });

  it("every definition has valid parameter metadata", () => {
    for (const def of Object.values(EFFECT_DEFS)) {
      expect(def.params.length).toBeGreaterThan(0);
      expect(def.name.length).toBeGreaterThan(0);
      const labels = new Set<string>();
      const ids = new Set<string>();
      for (const p of def.params) {
        expect(p.min).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        expect(p.label.length).toBeGreaterThan(0);
        labels.add(p.label);
        ids.add(p.id);
      }
      expect(labels.size).toBe(def.params.length);
      expect(ids.size).toBe(def.params.length);
    }
  });

  it("defaultParamsOf returns every parameter default", () => {
    for (const type of EFFECT_ORDER) {
      const def = EFFECT_DEFS[type];
      const params = defaultParamsOf(type);
      expect(Object.keys(params).sort()).toEqual(def.params.map((p) => p.id).sort());
      for (const p of def.params) {
        expect(params[p.id]).toBe(p.default);
      }
    }
  });

  it("clampEffectParam enforces bounds", () => {
    expect(clampEffectParam("eq", "lowGain", 99)).toBe(15);
    expect(clampEffectParam("eq", "lowGain", -99)).toBe(-15);
    expect(clampEffectParam("pump", "rate", 12)).toBe(PUMP_DIVISIONS.length - 1);
    expect(clampEffectParam("saturation", "drive", 0.42)).toBeCloseTo(0.42, 5);
  });

  it("pump divisions map to distinct multipliers", () => {
    const mults = PUMP_DIVISIONS.map((d) => d.mult);
    expect(new Set(mults).size).toBe(mults.length);
    expect(mults).toEqual([...mults].sort((a, b) => a - b));
  });
});

describe("duckCurve", () => {
  it("starts at full duck and decays monotonically", () => {
    for (const release of [0, 0.3, 0.7, 1]) {
      const curve = duckCurve(release, 256);
      expect(curve[0]).toBeCloseTo(1, 5);
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i]).toBeLessThan(curve[i - 1]);
      }
      expect(curve[curve.length - 1]).toBeLessThan(0.05);
    }
  });

  it("higher release decays faster", () => {
    const slow = duckCurve(0.1, 256);
    const fast = duckCurve(0.9, 256);
    const mid = Math.floor(256 / 2);
    expect(fast[mid]).toBeLessThan(slow[mid]);
  });
});

describe.skipIf(typeof OfflineAudioContext === "undefined")("effect runtimes", () => {
  const SR = 44100;

  async function renderThrough(type: EffectType): Promise<{ peak: number }> {
    const ctx = new OfflineAudioContext(1, SR / 2, SR);
    const def = EFFECT_DEFS[type];
    const rt = def.factory(
      ctx,
      { id: "test-fx", type, bypassed: false, params: defaultParamsOf(type) },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    const sourceGain = ctx.createGain();
    sourceGain.gain.value = 0.5;
    osc.connect(sourceGain).connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    let peak = 0;
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    return { peak };
  }

  it.each(EFFECT_ORDER)("%s constructs, accepts param updates, renders signal", async (type) => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const def = EFFECT_DEFS[type];
    const rt = def.factory(ctx, { id: "t", type, bypassed: false, params: defaultParamsOf(type) }, { bpm: 124 });
    for (const p of def.params) {
      rt.setParameter(p.id, p.min);
      rt.setParameter(p.id, p.max);
      rt.setParameter(p.id, p.default);
    }
    rt.syncBpm?.(140);
    rt.onTransportStarted?.(0, 0);
    rt.dispose();
    const { peak } = await renderThrough(type);
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("clipper honors the ceiling", async () => {
    const ctx = new OfflineAudioContext(1, SR / 2, SR);
    const params = { ...defaultParamsOf("clipper"), drive: 1, ceiling: -6, softness: 0, output: 0 };
    const rt = EFFECT_DEFS.clipper.factory(ctx, { id: "t", type: "clipper", bypassed: false, params }, { bpm: 124 });
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    const ceiling = Math.pow(10, -6 / 20);
    for (let i = 0; i < data.length; i++) {
      expect(Math.abs(data[i])).toBeLessThanOrEqual(ceiling + 0.01);
    }
  });
});
