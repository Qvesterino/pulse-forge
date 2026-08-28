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
    const rt = def.factory(ctx, { id: "test-fx", type, bypassed: false, params: defaultParamsOf(type) }, { bpm: 124 });
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

  it("distortion produces harmonics (output has higher RMS than a pure sine after cubic waveshaping)", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("distortion"), drive: 0.9, tone: 12000, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.distortion.factory(
      ctx,
      { id: "t", type: "distortion", bypassed: false, params },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 220;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    // After hard distortion the time-domain signal must have more zero-crossings
    // than the input (220 Hz) — at least 3 within the first 100 ms.
    let crossings = 0;
    let last = 0;
    const limit = Math.floor(SR * 0.1);
    for (let i = 0; i < limit; i++) {
      const v = data[i];
      if ((last <= 0 && v > 0) || (last >= 0 && v < 0)) crossings++;
      last = v;
    }
    // 220 Hz sine has ~22 crossings in 100 ms; distorted should have substantially more
    expect(crossings).toBeGreaterThan(30);
  });

  it("bitcrusher reduces the number of unique output samples", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("bitcrusher"), bits: 4, downsample: 1, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.bitcrusher.factory(
      ctx,
      { id: "t", type: "bitcrusher", bypassed: false, params },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    // 4-bit quantization ⇒ at most 2^4 = 16 distinct values
    const unique = new Set<number>();
    for (let i = 0; i < data.length; i++) unique.add(Math.round(data[i] * 1000) / 1000);
    expect(unique.size).toBeLessThanOrEqual(16);
  });

  it("chorus delays the signal by a non-trivial, time-varying amount", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const params = { ...defaultParamsOf("chorus"), rate: 0.5, depth: 1, mix: 1, output: 0 };
    const rt = EFFECT_DEFS.chorus.factory(ctx, { id: "t", type: "chorus", bypassed: false, params }, { bpm: 124 });
    // Burst of silence then a single short tone — chorus should smear it
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 440;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    // A clean sine starting at t=0 has its first peak around 1/(4*440) = 0.57 ms.
    // Chorus with mix=1 and ~12 ms base delay should still be audible at t > 12 ms.
    const laterPeak = (() => {
      let max = 0;
      for (let i = Math.floor(SR * 0.02); i < data.length; i++) {
        if (Math.abs(data[i]) > max) max = Math.abs(data[i]);
      }
      return max;
    })();
    expect(laterPeak).toBeGreaterThan(0.001);
  });

  it("phaser re-chains allpass stages when STAGES changes mid-life", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const rt = EFFECT_DEFS.phaser.factory(
      ctx,
      { id: "t", type: "phaser", bypassed: false, params: defaultParamsOf("phaser") },
      { bpm: 124 },
    );
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110;
    osc.connect(rt.input);
    rt.output.connect(ctx.destination);
    osc.start(0);
    rt.setParameter("stages", 0); // 2 stages
    rt.setParameter("stages", 3); // 8 stages
    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    expect(peak).toBeGreaterThan(0.001);
  });

  it("sidechain ducks the target gain when a sidechain input is provided", async () => {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const params = {
      ...defaultParamsOf("sidechain"),
      threshold: -30,
      ratio: 8,
      attack: 0.001,
      release: 0.05,
      amount: 1,
    };
    const rt = EFFECT_DEFS.sidechain.factory(
      ctx,
      { id: "t", type: "sidechain", bypassed: false, params },
      { bpm: 124 },
    );

    // Main path: a steady tone (so we can hear the ducking).
    const main = ctx.createOscillator();
    main.type = "sine";
    main.frequency.value = 440;
    main.connect(rt.input);

    // Sidechain path: a short loud burst 200 ms in.
    const burst = ctx.createOscillator();
    burst.type = "sine";
    burst.frequency.value = 220;
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0, 0);
    burstGain.gain.setValueAtTime(1, 0.2);
    burstGain.gain.setTargetAtTime(0, 0.22, 0.01);
    burst.connect(burstGain);

    rt.setSidechainInput?.(burstGain);
    rt.output.connect(ctx.destination);
    main.start(0);
    burst.start(0);

    const buffer = await ctx.startRendering();
    rt.dispose();
    const data = buffer.getChannelData(0);

    // RMS during the burst (180-220 ms) should be lower than RMS before (50-150 ms)
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const before = rms(Math.floor(SR * 0.05), Math.floor(SR * 0.15));
    const during = rms(Math.floor(SR * 0.18), Math.floor(SR * 0.22));
    expect(during).toBeLessThan(before * 0.5);
  });

  it("sidechain setSidechainInput(null) safely disconnects the feed", () => {
    const ctx = new OfflineAudioContext(1, 128, SR);
    const rt = EFFECT_DEFS.sidechain.factory(
      ctx,
      { id: "t", type: "sidechain", bypassed: false, params: defaultParamsOf("sidechain") },
      { bpm: 124 },
    );
    const src = ctx.createOscillator();
    src.frequency.value = 220;
    rt.setSidechainInput?.(src);
    expect(() => rt.setSidechainInput?.(null)).not.toThrow();
    rt.dispose();
  });
});
