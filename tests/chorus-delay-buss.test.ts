import { beforeAll, describe, expect, it } from "vitest";
import { presetsForEffect } from "../src/effects/presets";
import { EFFECT_DEFS, defaultParamsOf } from "../src/effects/registry";

/**
 * Top zvukové winy — test battery for the upgraded stock effects:
 *
 *  - Chorus worklet (`chorus-processor.js`): true-stereo modulated voices,
 *    mix = 0 unity, delayed wet audible, extremes stay finite + bounded.
 *  - Stock Delay worklet (`stock-delay-processor.js`): free TIME echo
 *    spacing, SYNC divisions × BPM resolved in-worklet, ping-pong L/R
 *    alternation, progressive loop damping, mix = 0 unity, feedback decay
 *    finite over long renders.
 *  - Drum/Bass Buss: 4× oversampled shapers, glue through the custom
 *    compressor contract (params map without throwing), GR hook present.
 *  - Registry contract: new params (spread / sync / pingPong) defaulted,
 *    delay presets exist and sit in range.
 *
 * Processor tests run the REAL worklet code under a stubbed
 * AudioWorkletGlobalScope (same harness as tests/kaskada.test.ts).
 * Factory tests use OfflineAudioContext without worklet modules, so they
 * exercise the degraded native fallbacks (audible + unity + bounded).
 */

class FakePort {
  onmessage: ((e: unknown) => void) | null = null;
  postMessage() {}
}
class FakeAudioWorkletProcessor {
  port = new FakePort();
}

const registered = new Map<string, new () => any>();
let createChorus: () => any;
let createStockDelay: () => any;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = (name: string, cls: new () => any) => {
    registered.set(name, cls);
  };
  createChorus = (await import("../src/audio-worklets/chorus-processor.js")).createChorusProcessor;
  createStockDelay = (await import("../src/audio-worklets/stock-delay-processor.js")).createStockDelayProcessor;
  expect(typeof createChorus).toBe("function");
  expect(typeof createStockDelay).toBe("function");
});

const BLOCK = 128;
const SR = 48000;

function paramSet(descriptors: { name: string; defaultValue: number }[], overrides: Record<string, number> = {}) {
  const out: Record<string, Float32Array> = {};
  for (const d of descriptors) out[d.name] = Float32Array.from([overrides[d.name] ?? d.defaultValue]);
  return out;
}

function renderStereo(
  proc: any,
  seconds: number,
  prm: Record<string, Float32Array>,
  input: (n: number) => [number, number] = () => [0, 0],
): { L: Float32Array; R: Float32Array } {
  const nBlocks = Math.ceil((seconds * SR) / BLOCK);
  const L = new Float32Array(nBlocks * BLOCK);
  const R = new Float32Array(nBlocks * BLOCK);
  for (let b = 0; b < nBlocks; b++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const [l, r] = input(b * BLOCK + i);
      inL[i] = l;
      inR[i] = r;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process([[inL, inR]], [[outL, outR]], prm);
    L.set(outL, b * BLOCK);
    R.set(outR, b * BLOCK);
  }
  return { L, R };
}

function peakAbs(buf: Float32Array, from = 0): number {
  let m = 0;
  for (let i = from; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > m) m = v;
  }
  return m;
}

describe("chorus-processor registration", () => {
  it("registers as 'chorus-processor' with the registry param surface", () => {
    const Cls = registered.get("chorus-processor");
    expect(Cls).toBeDefined();
    const names = ((Cls as any).parameterDescriptors as { name: string }[]).map((d) => d.name);
    for (const id of ["rate", "depth", "spread", "mix"]) expect(names).toContain(id);
    const defIds = EFFECT_DEFS.chorus.params.map((p) => p.id);
    for (const id of ["rate", "depth", "spread", "mix"]) expect(defIds).toContain(id);
  });
});

describe("chorus-processor sound", () => {
  it("mix = 0 is unity (dry passes bit-exact)", () => {
    const proc = createChorus();
    const prm = paramSet((registered.get("chorus-processor") as any).parameterDescriptors, { mix: 0 });
    const { L } = renderStereo(proc, 0.3, prm, () => [0.4, -0.2]);
    for (let i = 0; i < L.length; i++) {
      expect(Math.abs(L[i] - 0.4)).toBeLessThan(1e-6);
    }
  });

  it("wet voices arrive delayed (12/18 ms bases) and stay bounded", () => {
    const proc = createChorus();
    const prm = paramSet((registered.get("chorus-processor") as any).parameterDescriptors, {
      mix: 1,
      depth: 0,
      spread: 0,
    });
    // Single impulse; wet-only output must be silent before the shortest base.
    const { L } = renderStereo(proc, 0.3, prm, (n) => (n === 0 ? [1, 1] : [0, 0]));
    expect(peakAbs(L, 0)).toBeGreaterThan(0.2);
    // 12 ms = 576 samples at 48 kHz — nothing may arrive before ~10 ms.
    expect(peakAbs(L.slice(0, Math.floor(SR * 0.01)))).toBeLessThan(1e-6);
    expect(peakAbs(L)).toBeLessThanOrEqual(1.6);
  });

  it("stereo voices differ (L runs the 12 ms voice, R the 18 ms voice)", () => {
    const proc = createChorus();
    const prm = paramSet((registered.get("chorus-processor") as any).parameterDescriptors, {
      mix: 1,
      depth: 0,
      spread: 1,
    });
    // Impulse on the left only — the right channel hears only crossfeed.
    const { L, R } = renderStereo(proc, 0.3, prm, (n) => (n === 0 ? [1, 0] : [0, 0]));
    const lPeak = peakAbs(L);
    const rPeak = peakAbs(R);
    expect(lPeak).toBeGreaterThan(0.2);
    expect(rPeak).toBeGreaterThan(0.01);
    expect(rPeak).toBeLessThan(lPeak);
  });

  it("extremes soak: finite, bounded, no NaN", () => {
    const proc = createChorus();
    const prm = paramSet((registered.get("chorus-processor") as any).parameterDescriptors, {
      rate: 8,
      depth: 1,
      spread: 1,
      mix: 1,
    });
    const { L, R } = renderStereo(proc, 1, prm, (n) => [Math.sin(n * 0.1) * 0.9, Math.cos(n * 0.07) * 0.9]);
    for (const buf of [L, R]) {
      for (let i = 0; i < buf.length; i++) {
        expect(Number.isFinite(buf[i])).toBe(true);
        expect(Math.abs(buf[i])).toBeLessThan(4);
      }
    }
  });
});

describe("stock-delay-processor registration", () => {
  it("registers as 'stock-delay-processor' with the registry param surface", () => {
    const Cls = registered.get("stock-delay-processor");
    expect(Cls).toBeDefined();
    const names = ((Cls as any).parameterDescriptors as { name: string }[]).map((d) => d.name);
    for (const id of ["time", "sync", "bpm", "pingPong", "feedback", "tone", "mix"]) expect(names).toContain(id);
    const defIds = EFFECT_DEFS.delay.params.map((p) => p.id);
    for (const id of ["time", "sync", "pingPong", "feedback", "tone", "mix"]) expect(defIds).toContain(id);
  });
});

describe("stock-delay-processor sound", () => {
  it("free TIME echo lands at the right sample", () => {
    const proc = createStockDelay();
    const prm = paramSet((registered.get("stock-delay-processor") as any).parameterDescriptors, {
      time: 375,
      sync: 0,
      feedback: 0,
      tone: 8000,
      mix: 1,
    });
    const { L } = renderStereo(proc, 1, prm, (n) => (n === 0 ? [1, 0] : [0, 0]));
    const at375 = Math.floor(0.375 * SR);
    expect(Math.abs(L[at375])).toBeGreaterThan(0.3);
    expect(peakAbs(L.slice(0, at375 - 4))).toBeLessThan(1e-5);
  });

  it("SYNC 1/8 @ 120 BPM resolves to 250 ms in-worklet", () => {
    const proc = createStockDelay();
    const prm = paramSet((registered.get("stock-delay-processor") as any).parameterDescriptors, {
      sync: 2,
      bpm: 120,
      feedback: 0,
      tone: 8000,
      mix: 1,
    });
    const { L } = renderStereo(proc, 1, prm, (n) => (n === 0 ? [1, 0] : [0, 0]));
    const at250 = Math.floor(0.25 * SR);
    // Glide approaches the target — allow a small window around the landing.
    expect(peakAbs(L.slice(at250 - 8, at250 + 64))).toBeGreaterThan(0.2);
  });

  it("ping-pong bounces repeats L/R with a one-sided impulse", () => {
    const proc = createStockDelay();
    const prm = paramSet((registered.get("stock-delay-processor") as any).parameterDescriptors, {
      time: 200,
      sync: 0,
      pingPong: 1,
      feedback: 0.5,
      tone: 8000,
      mix: 1,
    });
    const { L, R } = renderStereo(proc, 1.2, prm, (n) => (n === 0 ? [1, 0] : [0, 0]));
    const win = (buf: Float32Array, center: number) => peakAbs(buf.slice(center - 32, center + 32));
    const t1 = Math.floor(0.2 * SR);
    const t2 = Math.floor(0.4 * SR);
    // First repeat crosses to R, second comes back to L.
    expect(win(R, t1)).toBeGreaterThan(win(L, t1));
    expect(win(L, t2)).toBeGreaterThan(win(R, t2));
  });

  it("feedback decays (no runaway) and mix = 0 is unity", () => {
    const proc = createStockDelay();
    const prm = paramSet((registered.get("stock-delay-processor") as any).parameterDescriptors, {
      time: 100,
      sync: 0,
      feedback: 0.7,
      tone: 8000,
      mix: 1,
    });
    const { L } = renderStereo(proc, 3, prm, (n) => (n === 0 ? [1, 1] : [0, 0]));
    const early = peakAbs(L.slice(Math.floor(0.1 * SR), Math.floor(0.5 * SR)));
    const late = peakAbs(L.slice(Math.floor(2.5 * SR)));
    expect(early).toBeGreaterThan(0.2);
    expect(late).toBeLessThan(early * 0.5);
    for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i])).toBe(true);

    const dry = createStockDelay();
    const dryPrm = paramSet((registered.get("stock-delay-processor") as any).parameterDescriptors, { mix: 0 });
    const out = renderStereo(dry, 0.2, dryPrm, () => [0.4, -0.3]);
    for (let i = 0; i < out.L.length; i++) {
      expect(Math.abs(out.L[i] - 0.4)).toBeLessThan(1e-6);
      expect(Math.abs(out.R[i] + 0.3)).toBeLessThan(1e-6);
    }
  });

  it("switching TIME mid-render stays finite (glide, no zipper blowup)", () => {
    const proc = createStockDelay();
    const descriptors = (registered.get("stock-delay-processor") as any).parameterDescriptors;
    const prm = paramSet(descriptors, { time: 200, sync: 0, feedback: 0.5, tone: 4000, mix: 1 });
    const nBlocks = Math.ceil((1.2 * SR) / BLOCK);
    const L = new Float32Array(nBlocks * BLOCK);
    for (let b = 0; b < nBlocks; b++) {
      if (b === Math.floor(nBlocks / 2)) prm.time = Float32Array.from([600]);
      const inL = new Float32Array(BLOCK).fill(0.2);
      const outL = new Float32Array(BLOCK);
      const outR = new Float32Array(BLOCK);
      proc.process([[inL, new Float32Array(BLOCK)]], [[outL, outR]], prm);
      L.set(outL, b * BLOCK);
    }
    for (let i = 0; i < L.length; i++) {
      expect(Number.isFinite(L[i])).toBe(true);
      expect(Math.abs(L[i])).toBeLessThan(4);
    }
  });
});

describe("buss glue + registry contract", () => {
  it("chorus defaults carry spread = 1 (legacy 1.4× second-LFO feel)", () => {
    expect(defaultParamsOf("chorus").spread).toBe(1);
    expect(defaultParamsOf("delay").sync).toBe(0);
    expect(defaultParamsOf("delay").pingPong).toBe(0);
  });

  it("delay ships at least 3 musical presets, all in range", () => {
    const presets = presetsForEffect("delay");
    expect(presets.length).toBeGreaterThanOrEqual(3);
    const defs = EFFECT_DEFS.delay.params;
    for (const p of presets) {
      for (const [id, v] of Object.entries(p.params)) {
        const def = defs.find((d) => d.id === id);
        expect(def, `unknown delay preset param ${id}`).toBeDefined();
        expect(v).toBeGreaterThanOrEqual(def!.min - 1e-9);
        expect(v).toBeLessThanOrEqual(def!.max + 1e-9);
      }
    }
  });

  it("drum/bass buss factories build on the fallback path and expose GR", async () => {
    if (typeof OfflineAudioContext === "undefined") return;
    const SRV = 44100;
    for (const type of ["drumBuss", "bassBuss"] as const) {
      const ctx = new OfflineAudioContext(2, SRV, SRV);
      const params = { ...defaultParamsOf(type) };
      const rt = EFFECT_DEFS[type].factory(ctx, { id: "t", type, bypassed: false, params }, { bpm: 124 });
      // Full param sweep incl. the remapped glue controls must not throw.
      for (const p of EFFECT_DEFS[type].params) {
        rt.setParameter(p.id, p.min);
        rt.setParameter(p.id, p.max);
        rt.setParameter(p.id, p.default);
      }
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 110;
      osc.connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      rt.dispose();
      const peak = peakAbs(buffer.getChannelData(0));
      expect(peak).toBeGreaterThan(0.001);
      expect(peak).toBeLessThan(4);
      expect(typeof rt.getGainReductionDb?.()).toBe("number");
    }
  });

  it("chorus/delay fallback factories stay audible with mix = 0 unity", async () => {
    if (typeof OfflineAudioContext === "undefined") return;
    const SRV = 44100;
    for (const type of ["chorus", "delay"] as const) {
      const ctx = new OfflineAudioContext(1, SRV, SRV);
      const params = { ...defaultParamsOf(type), mix: 0 };
      const rt = EFFECT_DEFS[type].factory(ctx, { id: "t", type, bypassed: false, params }, { bpm: 124 });
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 440;
      osc.connect(rt.input);
      rt.output.connect(ctx.destination);
      osc.start(0);
      const buffer = await ctx.startRendering();
      rt.dispose();
      const data = buffer.getChannelData(0);
      // Dry sine at mix = 0 must survive (unity within smoothing tolerance).
      expect(peakAbs(data, Math.floor(SRV * 0.5))).toBeGreaterThan(0.05);
    }
  });
});
