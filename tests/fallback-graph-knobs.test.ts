import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EFFECT_DEFS, effectProcessorStatus } from "../src/effects/registry";
import { EFFECT_META, defaultParamsOf } from "../src/effects/definitions";
import type { EffectType } from "../src/project-model/types";

/**
 * FALLBACK-GRAPH KNOB SWEEP (signal-flow audit re-run 2026-10).
 *
 * The param-range-coherence sweep pins def↔descriptor coherence for the REAL
 * AudioWorklet DSP. This file pins the OTHER path every degraded effect can
 * take: the native Web Audio fallback graph. The audit found the fallbacks
 * honest but UNPINNED — one refactor could silently drop a knob conversion
 * (makeup dB→linear), resurrect a dropped knob as a wrong-domain write, or
 * lose the `degraded` surfacing the UI warns with. Pins per effect:
 *
 *   - severity contract: effectProcessorStatus says "fallback" (never "ok")
 *     on a worklet-less context, and the runtime carries degraded + reason;
 *   - EXTREME SWEEP: every def param at min AND max through setParameter —
 *     no throw, runtime still degraded (dropped knobs are stored-only);
 *   - the documented fallback conversions/limits: compressor makeup dB→lin,
 *     delay ms→s, reverb tone/damping merge on one lowpass, reverb decay
 *     rebuilds the IR buffer, bitcrusher CRUSH inert on the WaveShaper path,
 *     sidechain 1 ms attack/release floor (code-level, source-pinned).
 */

const FALLBACK_TYPES: EffectType[] = ["reverb", "compressor", "sidechain", "chorus", "delay", "bitcrusher", "eq"];

type Write = { param: string; value: number };
let writes: Write[] = [];
let lastShaperCurve: Float32Array | null = null;
let lastConvolverBuffer: unknown = null;

function param(name: string, initial = 0) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(v: number) {
      value = v;
      writes.push({ param: name, value: v });
    },
    setTargetAtTime(v: number) {
      value = v;
      writes.push({ param: name, value: v });
    },
    setValueAtTime(v: number) {
      value = v;
      writes.push({ param: name, value: v });
    },
    linearRampToValueAtTime(v: number) {
      value = v;
      writes.push({ param: name, value: v });
    },
  };
}

function mockNode(params: Record<string, ReturnType<typeof param>> = {}) {
  const node = {
    gain: params.gain ?? param("gain", 1),
    pan: params.pan ?? param("pan", 0),
    frequency: params.frequency ?? param("frequency", 440),
    Q: params.Q ?? param("Q", 1),
    threshold: params.threshold ?? param("threshold", -24),
    ratio: params.ratio ?? param("ratio", 3),
    attack: params.attack ?? param("attack", 0.003),
    release: params.release ?? param("release", 0.25),
    knee: params.knee ?? param("knee", 30),
    delayTime: params.delayTime ?? param("delayTime", 0),
    type: "lowpass",
    fftSize: 2048,
    channelCount: 2,
    channelCountMode: "explicit" as const,
    reduction: 0,
    getFloatTimeDomainData() {},
    getByteTimeDomainData() {},
    getByteFrequencyData() {},
    connect(destination?: unknown) {
      if (destination !== undefined) void destination;
      return node;
    },
    disconnect() {},
    start() {},
    stop() {},
  };
  return node;
}

function mockCtx() {
  writes = [];
  lastShaperCurve = null;
  lastConvolverBuffer = null;
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => mockNode(),
    createStereoPanner: () => mockNode(),
    createAnalyser: () => mockNode(),
    createDelay: () => mockNode(),
    createDynamicsCompressor: () => mockNode(),
    createBiquadFilter: () => mockNode(),
    createOscillator: () => mockNode(),
    createConvolver: () => {
      const conv = {
        buffer: null as unknown,
        connect(destination?: unknown) {
          void destination;
          return conv;
        },
        disconnect() {},
      };
      Object.defineProperty(conv, "buffer", {
        get: () => lastConvolverBuffer,
        set: (value: unknown) => {
          lastConvolverBuffer = value;
        },
      });
      return conv;
    },
    createWaveShaper: () => {
      const shaper = {
        oversample: "none" as OverSampleType,
        connect(destination?: unknown) {
          void destination;
          return shaper;
        },
        disconnect() {},
      };
      Object.defineProperty(shaper, "curve", {
        get: () => lastShaperCurve,
        set: (value: Float32Array | null) => {
          lastShaperCurve = value;
        },
      });
      return shaper;
    },
    createBuffer(channels: number, length: number, sampleRate: number) {
      const data: Float32Array[] = [];
      for (let ch = 0; ch < channels; ch++) data.push(new Float32Array(Math.max(1, length)));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: (ch: number) => data[ch]!,
        copyToChannel: (source: Float32Array, ch: number) => {
          data[ch]?.set(source.subarray(0, Math.min(source.length, data[ch]!.length)));
        },
      };
    },
  };
}

function buildFallback(type: EffectType): import("../src/effects/types").EffectRuntime {
  const instance = { id: `fx-audit-${type}`, type, bypassed: false, params: defaultParamsOf(type) };
  return EFFECT_DEFS[type].factory(mockCtx() as unknown as BaseAudioContext, instance, { bpm: 120 });
}

describe("fallback graphs are surfaced, never silent", () => {
  it("native-approximation effects report status 'fallback' on a worklet-less context", () => {
    for (const type of FALLBACK_TYPES) {
      expect(effectProcessorStatus(type, mockCtx() as unknown as BaseAudioContext), type).toBe("fallback");
    }
  });

  it("critical effects (no native approximation) report 'bypassed', never 'ok'", () => {
    for (const type of ["gate", "limiter", "tapeSat", "svFilter", "transient", "stutter"] as EffectType[]) {
      expect(effectProcessorStatus(type, mockCtx() as unknown as BaseAudioContext), type).toBe("bypassed");
    }
  });

  it("every fallback runtime carries degraded: true with an honest reason", () => {
    for (const type of FALLBACK_TYPES) {
      const rt = buildFallback(type);
      expect(rt.degraded, `${type} degraded flag`).toBe(true);
      expect(rt.degradedReason?.length ?? 0, `${type} reason`).toBeGreaterThan(0);
      rt.dispose();
    }
  });
});

describe("fallback knob sweep — every def param survives min AND max", () => {
  for (const type of FALLBACK_TYPES) {
    it(`${type}: def-range extremes never throw the fallback graph`, () => {
      const rt = buildFallback(type);
      for (const def of EFFECT_META[type].params) {
        for (const value of [def.min, def.max]) {
          expect(() => rt.setParameter(def.id, value), `${type}.${def.id}@${value}`).not.toThrow();
        }
      }
      expect(rt.degraded).toBe(true);
      rt.dispose();
    });
  }
});

describe("documented fallback conversions and limits", () => {
  it("compressor: makeup is dB→linear on the fallback path; dropped knobs write NOTHING", () => {
    const rt = buildFallback("compressor");
    writes = [];
    rt.setParameter("makeup", 6);
    const dbToLin = Math.pow(10, 6 / 20);
    expect(writes.some((w) => w.param === "gain" && Math.abs(w.value - dbToLin) < 1e-6)).toBe(true);
    writes = [];
    // detector/scHpf have no native equivalent — stored-only, zero graph writes.
    rt.setParameter("detector", 1);
    rt.setParameter("scHpf", 500);
    expect(writes).toHaveLength(0);
    rt.dispose();
  });

  it("delay: time lands in seconds on delayTime; sync/pingPong are stored-only", () => {
    const rt = buildFallback("delay");
    writes = [];
    rt.setParameter("time", 500);
    expect(writes.some((w) => w.param === "delayTime" && Math.abs(w.value - 0.5) < 1e-9)).toBe(true);
    writes = [];
    rt.setParameter("sync", 3);
    rt.setParameter("pingPong", 1);
    expect(writes).toHaveLength(0);
    rt.dispose();
  });

  it("reverb: tone and damping share ONE lowpass (documented merge); diffusion writes nothing; decay rebuilds the IR", () => {
    const rt = buildFallback("reverb");
    writes = [];
    rt.setParameter("damping", 8000);
    expect(writes.some((w) => w.param === "frequency" && w.value === 8000)).toBe(true);
    rt.setParameter("tone", 6000);
    expect(writes.some((w) => w.param === "frequency" && w.value === 6000)).toBe(true);
    writes = [];
    rt.setParameter("diffusion", 0.8);
    expect(writes).toHaveLength(0);
    rt.setParameter("decay", 1.2);
    expect(lastConvolverBuffer).not.toBeNull(); // sync IR rebuild (Worker unavailable in vitest)
    rt.dispose();
  });

  it("bitcrusher: bits shapes the WaveShaper curve; CRUSH is inert on the fallback (documented)", () => {
    const rt = buildFallback("bitcrusher");
    rt.setParameter("bits", 4);
    expect(lastShaperCurve).not.toBeNull();
    expect(lastShaperCurve!.length).toBe(16); // 2^4 quantisation steps
    rt.setParameter("downsample", 64);
    expect(lastShaperCurve!.length).toBe(16); // unchanged — CRUSH stays stored-only
    rt.dispose();
  });

  it("sidechain: the 1 ms attack/release floor is code-level (def min 0.2 ms is floored, not clamped)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/effects/registry.ts"), "utf8");
    expect(src.match(/Math\.max\(0\.001, v\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Behavior: the extreme def min flows through the floor without throwing.
    const rt = buildFallback("sidechain");
    expect(() => rt.setParameter("attack", 0.0002)).not.toThrow();
    expect(() => rt.setParameter("release", 0.0002)).not.toThrow();
    rt.dispose();
  });
});
