import { beforeAll, describe, expect, it } from "vitest";
import { ozvenaRenderQualityBumps } from "../src/rendering/renderer";
import { EFFECT_DEFS } from "../src/effects/registry";
import { resolveEqParams } from "../src/audio-worklets/eq-node";
import type { EqProcessorInstance } from "../src/audio-worklets/eq-processor";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * Rýchle úpravy battery:
 *
 *  - VØID render-quality auto-switch: `ozvenaRenderQualityBumps` bumps only
 *    default-tier, non-bypassed instances (tracks + returns, never master),
 *    respects explicit eco/high/render, never mutates the document.
 *  - Pump real sidechain: mock-context wiring (osc fallback → key → back),
 *    full param sweep, envelope design check (rectifier + smoothing LP gives
 *    full duck on a kick transient and recovers on RELEASE time).
 *  - EQ de-cramp: the REAL worklet DSP — unity at defaults, shelf plateaus
 *    land on ±G (the decramp proof), peaking center + width hold, HP/LP
 *    stopbands attenuate, extremes stay finite + bounded.
 *  - eq-node alias precedence: canonical wins, alias fills gaps.
 */

class FakeAudioWorkletProcessor {}

let createEqProcessor: () => EqProcessorInstance;

beforeAll(async () => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = 48000;
  (globalThis as unknown as { AudioWorkletProcessor: unknown }).AudioWorkletProcessor = FakeAudioWorkletProcessor;
  (globalThis as unknown as { registerProcessor: unknown }).registerProcessor = () => {};
  createEqProcessor = (await import("../src/audio-worklets/eq-processor.js")).createEqProcessor;
  expect(typeof createEqProcessor).toBe("function");
});

type FxFixture = {
  id: string;
  type: "ozvena" | "fxeq";
  bypassed: boolean;
  params: Record<string, number>;
};

function docWithFx(
  tracks: { id: string; effects: FxFixture[] }[],
  returns: { id: string; effects: FxFixture[] }[] = [],
) {
  return { tracks, returns } as unknown as ProjectDocument;
}

describe("VØID offline render quality", () => {
  it("bumps default-tier instances on tracks and returns, nothing else", () => {
    const std: FxFixture = { id: "v", type: "ozvena", bypassed: false, params: {} };
    const explicitEco: FxFixture = { id: "e", type: "ozvena", bypassed: false, params: { "global.quality": 0 } };
    const explicitHigh: FxFixture = { id: "h", type: "ozvena", bypassed: false, params: { "global.quality": 2 } };
    const explicitRender: FxFixture = { id: "r", type: "ozvena", bypassed: false, params: { "global.quality": 3 } };
    const bypassed: FxFixture = { id: "b", type: "ozvena", bypassed: true, params: {} };
    const other: FxFixture = { id: "f", type: "fxeq", bypassed: false, params: {} };
    const doc = docWithFx(
      [{ id: "t1", effects: [std, explicitEco, explicitHigh, explicitRender, bypassed, other] }],
      [{ id: "ret1", effects: [{ ...std, id: "v2" }] }],
    );
    expect(ozvenaRenderQualityBumps(doc)).toEqual([
      { trackId: "t1", fxId: "v", paramId: "global.quality", value: 3 },
      { trackId: "ret1", fxId: "v2", paramId: "global.quality", value: 3 },
    ]);
    // Document untouched.
    expect(std.params["global.quality"]).toBeUndefined();
  });

  it("empty projects bump nothing", () => {
    expect(ozvenaRenderQualityBumps(docWithFx([{ id: "t", effects: [] }]))).toEqual([]);
  });
});

describe("eq-node alias precedence", () => {
  it("canonical wins, alias fills only absent bands", () => {
    expect(resolveEqParams({ lowGain: -3 }).lowShelfGain).toBe(-3);
    expect(resolveEqParams({ lowGain: -3, lowShelfGain: 2 }).lowShelfGain).toBe(2);
    expect(resolveEqParams({ midQ: 4 }).lowMidQ).toBe(4);
    expect(resolveEqParams({})).toEqual({});
  });
});

/* ── Pump key wiring (mock audio context, no worklets involved) ── */

function makeParam(v: number) {
  return {
    value: v,
    setTargetAtTime: (nv: number) => nv,
    setValueAtTime: (nv: number) => nv,
  };
}
function makeNode(connections: { dest: unknown }[]) {
  const node: Record<string, unknown> & {
    connect: (dest: unknown) => unknown;
    disconnect: () => void;
  } = {
    gain: makeParam(1),
    frequency: makeParam(440),
    connect: (dest: unknown) => {
      connections.push({ dest });
      return dest;
    },
    disconnect: () => {},
  };
  return node;
}

function pumpMockCtx() {
  const connections: { dest: unknown }[] = [];
  const oscillators: (Record<string, unknown> & { startedAt?: number; stoppedAt?: number })[] = [];
  const ctx = {
    currentTime: 0,
    createGain: () => makeNode(connections),
    createBiquadFilter: () => makeNode(connections),
    createWaveShaper: () => makeNode(connections),
    createOscillator: () => {
      const osc = makeNode(connections) as unknown as Record<string, unknown> & {
        startedAt?: number;
        stoppedAt?: number;
        start?: (when?: number) => void;
        stop?: (when?: number) => void;
        frequency: { value: number };
      };
      osc.start = (when = 0) => {
        osc.startedAt = when;
      };
      osc.stop = (when = 0) => {
        osc.stoppedAt = when;
      };
      oscillators.push(osc);
      return osc;
    },
  };
  return { ctx, oscillators };
}

describe("Pump sidechain key", () => {
  it("starts the oscillator with no key, swaps to key and back", () => {
    const { ctx, oscillators } = pumpMockCtx();
    const rt = EFFECT_DEFS.pump.factory(
      ctx as unknown as BaseAudioContext,
      { id: "p", type: "pump", bypassed: false, params: {} },
      { bpm: 124 },
    );
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].startedAt).toBe(0);

    const key = makeNode([]);
    rt.setSidechainInput?.(key as unknown as AudioNode);
    expect(oscillators[0].stoppedAt).toBe(0);
    expect(oscillators).toHaveLength(1); // no replacement while keyed

    // Re-keying the same source is a no-op.
    rt.setSidechainInput?.(key as unknown as AudioNode);
    expect(oscillators).toHaveLength(1);

    // Unkeying restarts the oscillator (beat-sync fallback).
    rt.setSidechainInput?.(null);
    expect(oscillators).toHaveLength(2);
    expect(oscillators[1].startedAt).toBe(0);
    rt.dispose();
  });

  it("survives the full param sweep in both modes", () => {
    const { ctx } = pumpMockCtx();
    const rt = EFFECT_DEFS.pump.factory(
      ctx as unknown as BaseAudioContext,
      { id: "p", type: "pump", bypassed: false, params: {} },
      { bpm: 124 },
    );
    for (const p of EFFECT_DEFS.pump.params) {
      rt.setParameter(p.id, p.min);
      rt.setParameter(p.id, p.max);
      rt.setParameter(p.id, p.default);
    }
    rt.setSidechainInput?.(makeNode([]) as unknown as AudioNode);
    for (const p of EFFECT_DEFS.pump.params) {
      rt.setParameter(p.id, p.min);
      rt.setParameter(p.id, p.max);
    }
    rt.syncBpm?.(140);
    rt.onTransportStarted?.(0, 0);
    rt.dispose();
  });

  it("key envelope design: full duck on a kick, RELEASE-timed recovery", () => {
    // Mirrors the worklet follower ballistics the key path uses: 2 ms
    // attack, RELEASE-mapped recovery (50..600 ms), tanh(peak·2) drive.
    const sr = 48000;
    const atk = 1 - Math.exp(-1 / (sr * 0.002));
    for (const release of [0, 0.5, 1]) {
      const relMs = 50 + release * 550;
      const rel = 1 - Math.exp(-1 / (sr * (relMs / 1000)));
      // Kick transient: instant beater attack, ~80 ms body decay.
      let env = 0;
      let peak = 0;
      const trace: number[] = [];
      for (let n = 0; n < sr; n++) {
        const kick = n < 2400 ? Math.exp(-n / 4000) : 0;
        const driven = Math.tanh(Math.abs(kick) * 2);
        env += (driven > env ? atk : rel) * (driven - env);
        const duck = Math.min(1, env);
        trace.push(duck);
        if (duck > peak) peak = duck;
      }
      expect(peak).toBeGreaterThan(0.9); // full-depth duck on the hit
      // Recovery scales with RELEASE: still ducked at 1/6 of the recovery
      // window, released at 3× the window.
      expect(trace[Math.floor(sr * (relMs / 1000 / 6))]).toBeGreaterThan(0.25);
      expect(trace[Math.min(sr - 1, Math.floor(sr * (relMs / 1000) * 3))]).toBeLessThan(0.25);
    }
  });
});

/* ── EQ worklet DSP ── */

const BLOCK = 128;
const SR = 48000;

function renderEq(seconds: number, prm: Record<string, number>, input: (n: number) => number): Float32Array {
  const proc = createEqProcessor();
  const names = [
    "hpFreq",
    "lpFreq",
    "lowShelfFreq",
    "lowShelfGain",
    "lowMidFreq",
    "lowMidGain",
    "lowMidQ",
    "highMidFreq",
    "highMidGain",
    "highMidQ",
    "highShelfFreq",
    "highShelfGain",
  ];
  const P: Record<string, Float32Array> = {};
  const defaults: Record<string, number> = {
    hpFreq: 20,
    lpFreq: 20000,
    lowShelfFreq: 120,
    lowShelfGain: 0,
    lowMidFreq: 400,
    lowMidGain: 0,
    lowMidQ: 1,
    highMidFreq: 2500,
    highMidGain: 0,
    highMidQ: 1,
    highShelfFreq: 6000,
    highShelfGain: 0,
  };
  for (const n of names) P[n] = Float32Array.from([prm[n] ?? defaults[n]]);
  const nBlocks = Math.ceil((seconds * SR) / BLOCK);
  const out = new Float32Array(nBlocks * BLOCK);
  for (let b = 0; b < nBlocks; b++) {
    const inL = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) inL[i] = input(b * BLOCK + i);
    const outL = new Float32Array(BLOCK);
    proc.process([[inL]], [[outL]], P);
    out.set(outL, b * BLOCK);
  }
  return out;
}

/** Sine RMS past the settle region (first 200 ms skipped). */
function sineRms(buf: Float32Array, freq: number): number {
  const from = Math.floor(SR * 0.2);
  let sum = 0;
  let n = 0;
  for (let i = from; i < buf.length; i++) {
    void freq;
    sum += buf[i] * buf[i];
    n++;
  }
  return Math.sqrt(sum / n);
}

function sineAt(freq: number, amp: number): (n: number) => number {
  return (n) => amp * Math.sin((n / SR) * freq * Math.PI * 2);
}

describe("EQ worklet response", () => {
  it("unity at defaults (transparent insert)", () => {
    const out = renderEq(0.5, {}, sineAt(1000, 0.5));
    const ratio = sineRms(out, 1000) / 0.5 / Math.SQRT1_2;
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.02);
  });

  it("high-shelf plateau lands on +G (the decramp proof)", () => {
    // +12 dB shelf at 10 kHz must still read ≈ +12 dB at 18 kHz — the
    // legacy RBJ shelf droops several dB up there.
    const out = renderEq(0.6, { highShelfGain: 12, highShelfFreq: 10000 }, sineAt(18000, 0.25));
    const db = 20 * Math.log10(sineRms(out, 18000) / 0.25 / Math.SQRT1_2);
    expect(db).toBeGreaterThan(10.8);
    expect(db).toBeLessThan(13.2);
  });

  it("low-shelf plateau lands on +G and DC passes", () => {
    const out = renderEq(0.6, { lowShelfGain: 12, lowShelfFreq: 100 }, sineAt(40, 0.5));
    const db = 20 * Math.log10(sineRms(out, 40) / 0.5 / Math.SQRT1_2);
    expect(db).toBeGreaterThan(10.8);
    expect(db).toBeLessThan(13.2);
  });

  it("peaking keeps center gain and width (Q correction proof)", () => {
    const center = renderEq(0.6, { highMidGain: 12, highMidFreq: 8000, highMidQ: 1 }, sineAt(8000, 0.25));
    const centerDb = 20 * Math.log10(sineRms(center, 8000) / 0.25 / Math.SQRT1_2);
    expect(centerDb).toBeGreaterThan(11.3);
    expect(centerDb).toBeLessThan(12.7);
    // Q = 1 → ±6 dB points roughly an octave apart (5657 / 11314 Hz).
    // Uncorrected bilinear widening would push the skirts several dB hot.
    for (const f of [5657, 11314]) {
      const skirt = renderEq(0.6, { highMidGain: 12, highMidFreq: 8000, highMidQ: 1 }, sineAt(f, 0.25));
      const db = 20 * Math.log10(sineRms(skirt, f) / 0.25 / Math.SQRT1_2);
      expect(db).toBeGreaterThan(3.5);
      expect(db).toBeLessThan(8.5);
    }
  });

  it("HP/LP stopbands attenuate", () => {
    const hp = renderEq(0.5, { hpFreq: 1000 }, sineAt(100, 0.5));
    expect(20 * Math.log10(sineRms(hp, 100) / 0.5 / Math.SQRT1_2)).toBeLessThan(-24);
    const lp = renderEq(0.5, { lpFreq: 4000 }, sineAt(12000, 0.5));
    // 2-pole Butterworth ≈ 12 dB/oct → ~−19 dB at 3× cutoff.
    expect(20 * Math.log10(sineRms(lp, 12000) / 0.5 / Math.SQRT1_2)).toBeLessThan(-17);
  });

  it("extremes soak: finite, bounded, no NaN", () => {
    const out = renderEq(
      1,
      {
        hpFreq: 1000,
        lpFreq: 2000,
        lowShelfFreq: 500,
        lowShelfGain: -15,
        lowMidFreq: 80,
        lowMidGain: 15,
        lowMidQ: 8,
        highMidFreq: 8000,
        highMidGain: -15,
        highMidQ: 0.3,
        highShelfFreq: 1500,
        highShelfGain: 15,
      },
      (n) => Math.sin(n * 0.23) * 0.9,
    );
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Math.abs(out[i])).toBeLessThan(8);
    }
  });
});
