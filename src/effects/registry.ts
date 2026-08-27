import type { EffectDefinition, EffectRuntime, ParamDef } from "./types";
import type { EffectInstance, EffectType } from "../project-model/types";
import { hashString, mulberry32 } from "../shared/rng";
import { isWorkletReady } from "../audio-worklets/loader";
import { createBitcrusherNode } from "../audio-worklets/bitcrusher-node";
import { createSidechainNode } from "../audio-worklets/sidechain-node";
import { createLimiterNode } from "../audio-worklets/limiter-node";
import { createCompressorNode } from "../audio-worklets/compressor-node";

const dbToLin = (db: number) => Math.pow(10, db / 20);
const smooth = (param: AudioParam, value: number, when: number, tc = 0.02) =>
  param.setTargetAtTime(value, when, tc);

interface MixBus {
  input: GainNode;
  output: GainNode;
  wet: GainNode;
  setMix(m: number, when: number): void;
}

function mixBus(ctx: BaseAudioContext): MixBus {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(wet);
  const setMix = (m: number, when: number) => {
    smooth(wet.gain, m, when);
    smooth(dry.gain, 1 - m, when);
  };
  return { input, output, wet, setMix };
}

const formatDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const formatHz = (v: number) => `${Math.round(v)} Hz`;
const formatMs = (v: number) => `${Math.round(v)} ms`;
const formatPct = (v: number) => `${Math.round(v * 100)}%`;
const formatSec = (v: number) => `${v.toFixed(2)} s`;

/** Effects whose real DSP lives in an AudioWorklet processor. */
export const WORKLET_EFFECTS: Partial<Record<EffectType, "critical" | "degraded">> = {
  gate: "critical",
  transient: "critical",
  limiter: "critical",
  compressor: "degraded",
  bitcrusher: "degraded",
  sidechain: "degraded",
};

export type EffectProcessorStatus = "ok" | "bypassed" | "fallback";

/**
 * Whether `type` runs its real AudioWorklet DSP in this context. "bypassed"
 * means the effect cannot process at all right now (signal passes 1:1 — the
 * UI warns loudly); "fallback" means a reduced native approximation runs.
 */
export function effectProcessorStatus(
  type: EffectType,
  ctx: BaseAudioContext | null | undefined,
): EffectProcessorStatus {
  const severity = WORKLET_EFFECTS[type];
  if (!severity) return "ok";
  return isWorkletReady(
    type as "bitcrusher" | "sidechain" | "transient" | "gate" | "limiter" | "compressor",
    ctx,
  )
    ? "ok"
    : severity === "critical"
      ? "bypassed"
      : "fallback";
}

/** Transparent 1:1 passthrough for contexts where the worklet is unavailable. */
function bypassRuntime(ctx: BaseAudioContext, reason: string): EffectRuntime {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);
  return {
    input,
    output,
    degraded: true,
    degradedReason: reason,
    setParameter: () => undefined,
    dispose: () => {
      input.disconnect();
      output.disconnect();
    },
  };
}

/* ---------------- EQ ---------------- */

const eq: EffectDefinition = {
  type: "eq",
  name: "EQ",
  category: "tone",
  params: [
    { id: "hpFreq", label: "HP FREQ", min: 20, max: 1000, default: 20, unit: "Hz", format: formatHz },
    { id: "lpFreq", label: "LP FREQ", min: 2000, max: 20000, default: 20000, unit: "Hz", format: formatHz },
    { id: "lowShelfFreq", label: "LOW SHELF FREQ", min: 40, max: 500, default: 120, unit: "Hz", format: formatHz },
    { id: "lowShelfGain", label: "LOW SHELF", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "lowMidFreq", label: "LOW MID FREQ", min: 80, max: 2000, default: 400, unit: "Hz", format: formatHz },
    { id: "lowMidGain", label: "LOW MID", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "lowMidQ", label: "LOW MID Q", min: 0.3, max: 8, default: 1, format: (v) => v.toFixed(2) },
    { id: "highMidFreq", label: "HIGH MID FREQ", min: 500, max: 8000, default: 2500, unit: "Hz", format: formatHz },
    { id: "highMidGain", label: "HIGH MID", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "highMidQ", label: "HIGH MID Q", min: 0.3, max: 8, default: 1, format: (v) => v.toFixed(2) },
    { id: "highShelfFreq", label: "HIGH SHELF FREQ", min: 1500, max: 16000, default: 6000, unit: "Hz", format: formatHz },
    { id: "highShelfGain", label: "HIGH SHELF", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    // Legacy aliases remain in the registry so old documents and commands keep working.
    { id: "lowGain", label: "LOW", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "lowFreq", label: "LOW FREQ", min: 40, max: 400, default: 120, unit: "Hz", format: formatHz },
    { id: "midGain", label: "MID", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "midFreq", label: "MID FREQ", min: 200, max: 4000, default: 1000, unit: "Hz", format: formatHz },
    { id: "midQ", label: "MID Q", min: 0.3, max: 8, default: 1, format: (v) => v.toFixed(2) },
    { id: "highGain", label: "HIGH", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "highFreq", label: "HIGH FREQ", min: 1500, max: 12000, default: 6000, unit: "Hz", format: formatHz },
  ],
  factory(ctx, instance) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    const lowMid = ctx.createBiquadFilter();
    lowMid.type = "peaking";
    const highMid = ctx.createBiquadFilter();
    highMid.type = "peaking";
    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    hp.connect(low).connect(lowMid).connect(highMid).connect(high).connect(lp);
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "hpFreq": smooth(hp.frequency, v, when); break;
        case "lpFreq": smooth(lp.frequency, v, when); break;
        case "lowShelfGain": smooth(low.gain, v, when); break;
        case "lowShelfFreq": smooth(low.frequency, v, when); break;
        case "lowMidGain": smooth(lowMid.gain, v, when); break;
        case "lowMidFreq": smooth(lowMid.frequency, v, when); break;
        case "lowMidQ": smooth(lowMid.Q, v, when); break;
        case "highMidGain": smooth(highMid.gain, v, when); break;
        case "highMidFreq": smooth(highMid.frequency, v, when); break;
        case "highMidQ": smooth(highMid.Q, v, when); break;
        case "highShelfGain": smooth(high.gain, v, when); break;
        case "highShelfFreq": smooth(high.frequency, v, when); break;
        case "lowGain": if (instance.params.lowShelfGain === undefined) smooth(low.gain, v, when); break;
        case "lowFreq": if (instance.params.lowShelfFreq === undefined) smooth(low.frequency, v, when); break;
        case "midGain": if (instance.params.lowMidGain === undefined) smooth(lowMid.gain, v, when); break;
        case "midFreq": if (instance.params.lowMidFreq === undefined) smooth(lowMid.frequency, v, when); break;
        case "midQ": if (instance.params.lowMidQ === undefined) smooth(lowMid.Q, v, when); break;
        case "highGain": if (instance.params.highShelfGain === undefined) smooth(high.gain, v, when); break;
        case "highFreq": if (instance.params.highShelfFreq === undefined) smooth(high.frequency, v, when); break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: hp,
      output: lp,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => { hp.disconnect(); low.disconnect(); lowMid.disconnect(); highMid.disconnect(); high.disconnect(); lp.disconnect(); },
    };
  },
};

/* ---------------- Compressor ---------------- */

const compressor: EffectDefinition = {
  type: "compressor",
  name: "Compressor",
  category: "dynamics",
  params: [
    { id: "threshold", label: "THRESH", min: -60, max: 0, default: -18, unit: "dB", format: formatDb },
    { id: "ratio", label: "RATIO", min: 1, max: 20, default: 3, format: (v) => `${v.toFixed(1)}:1` },
    { id: "attack", label: "ATTACK", min: 0.001, max: 0.5, default: 0.01, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.02, max: 1, default: 0.2, unit: "s", format: formatMs },
    { id: "knee", label: "KNEE", min: 0, max: 40, default: 6, unit: "dB", format: formatDb },
    { id: "detector", label: "DETECTOR", min: 0, max: 1, default: 0, options: [{ value: 0, label: "RMS" }, { value: 1, label: "PEAK" }] },
    { id: "scHpf", label: "SC HPF", min: 20, max: 500, default: 20, unit: "Hz", format: formatHz },
    { id: "makeup", label: "MAKEUP", min: 0, max: 24, default: 0, unit: "dB", format: formatDb },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  ],
  factory(ctx, instance) {
    if (isWorkletReady("compressor", ctx)) return createCompressorNode(ctx, instance);
    // Native fallback: DynamicsCompressorNode approximation — no sidechain,
    // no detector HPF, coarse GR. Degraded so the UI warns (never silent).
    const mix = mixBus(ctx);
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    mix.wet.connect(comp).connect(makeup).connect(mix.output);
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "threshold": smooth(comp.threshold, v, when); break;
        case "ratio": smooth(comp.ratio, v, when); break;
        case "attack": smooth(comp.attack, v, when); break;
        case "release": smooth(comp.release, v, when); break;
        case "knee": smooth(comp.knee, v, when); break;
        case "makeup": smooth(makeup.gain, dbToLin(v), when); break;
        case "mix": mix.setMix(v, when); break;
        case "detector":
        case "scHpf": break; // no native equivalent — parameter stays stored
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    const reduction = () => {
      const raw = (comp as unknown as { reduction?: number | { value: number } }).reduction;
      const value = typeof raw === "number" ? raw : typeof raw === "object" && raw && typeof raw.value === "number" ? raw.value : 0;
      return Math.max(0, Number.isFinite(value) ? -value : 0);
    };
    return {
      input: mix.input,
      output: mix.output,
      degraded: true,
      degradedReason: "Fallback — native approximation (sidechain & HPF inactive)",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      setSidechainInput: () => undefined, // accepted, inactive on the fallback path
      getGainReductionDb: reduction,
      dispose: () => { mix.input.disconnect(); mix.output.disconnect(); comp.disconnect(); makeup.disconnect(); },
    };
  },
};

/* ---------------- Saturation ---------------- */

const saturation: EffectDefinition = {
  type: "saturation",
  name: "Saturation",
  category: "character",
  params: [
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "tone", label: "TONE", min: 500, max: 12000, default: 8000, unit: "Hz", format: formatHz },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
    { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "2x";
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    const out = ctx.createGain();
    mix.wet.connect(shaper).connect(tone).connect(out).connect(mix.output);
    const curveOf = (drive: number) => {
      const k = 1 + drive * 9;
      const n = 1024;
      const curve = new Float32Array(new ArrayBuffer(n * 4));
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * k);
      }
      return curve;
    };
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "drive": shaper.curve = curveOf(v); break;
        case "tone": smooth(tone.frequency, v, when); break;
        case "mix": mix.setMix(v, when); break;
        case "output": smooth(out.gain, dbToLin(v), when); break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => { mix.input.disconnect(); mix.output.disconnect(); shaper.disconnect(); tone.disconnect(); out.disconnect(); },
    };
  },
};

/* ---------------- Clipper ---------------- */

const clipper: EffectDefinition = {
  type: "clipper",
  name: "Clipper",
  category: "character",
  params: [
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "ceiling", label: "CEILING", min: -24, max: 0, default: -1, unit: "dB", format: formatDb },
    { id: "softness", label: "SOFTNESS", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const pre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "4x";
    const post = ctx.createGain();
    input.connect(pre).connect(shaper).connect(post).connect(output);
    let ceiling = instance.params.ceiling ?? -1;
    let softness = instance.params.softness ?? 0.2;
    const curveOf = () => {
      const c = dbToLin(ceiling);
      const n = 2048;
      const curve = new Float32Array(new ArrayBuffer(n * 4));
      for (let i = 0; i < n; i++) {
        const u = (i / (n - 1)) * 2 - 1;
        let shaped: number;
        if (softness < 0.02) {
          shaped = Math.max(-1, Math.min(1, u));
        } else {
          const k = 1 + softness * 7;
          shaped = Math.tanh(u * k) / Math.tanh(k);
        }
        curve[i] = c * shaped;
      }
      return curve;
    };
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "drive": smooth(pre.gain, 1 + v * 8, when); break;
        case "ceiling":
          ceiling = v;
          shaper.curve = curveOf();
          break;
        case "softness":
          softness = v;
          shaper.curve = curveOf();
          break;
        case "output": smooth(post.gain, dbToLin(v), when); break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input,
      output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => { input.disconnect(); output.disconnect(); pre.disconnect(); shaper.disconnect(); post.disconnect(); },
    };
  },
};

/* ---------------- Reverb ---------------- */

function makeImpulseResponse(ctx: BaseAudioContext, decaySec: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * decaySec));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const rand = mulberry32(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (rand() * 2 - 1) * Math.pow(1 - i / length, 2.4);
    }
  }
  return buffer;
}

const reverb: EffectDefinition = {
  type: "reverb",
  name: "Reverb",
  category: "space",
  params: [
    { id: "decay", label: "DECAY", min: 0.1, max: 6, default: 1.8, unit: "s", format: formatSec },
    { id: "predelay", label: "PRE-DLY", min: 0, max: 120, default: 20, unit: "ms", format: formatMs },
    { id: "tone", label: "TONE", min: 500, max: 12000, default: 6000, unit: "Hz", format: formatHz },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 0.3, format: formatPct },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    mix.setMix(instance.params.mix ?? 0.3, ctx.currentTime);
    const preDelay = ctx.createDelay(0.5);
    const conv = ctx.createConvolver();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    mix.wet.connect(preDelay).connect(conv).connect(tone).connect(mix.output);
    const seed = hashString(instance.id);

    // Web Worker for IR generation (avoids main-thread glitch on decay change)
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("../audio-workers/ir-generator.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ left: Float32Array; right: Float32Array; length: number }>) => {
        const { left, right, length } = e.data;
        const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
        buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
        buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
        conv.buffer = buffer;
      };
    } catch {
      // Worker not available (e.g. in test environment) — use synchronous fallback
    }

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "decay":
          if (worker) {
            worker.postMessage({ decay: v, sampleRate: ctx.sampleRate, seed });
          } else {
            conv.buffer = makeImpulseResponse(ctx, v, seed);
          }
          break;
        case "predelay": smooth(preDelay.delayTime, v / 1000, when, 0.05); break;
        case "tone": smooth(tone.frequency, v, when); break;
        case "mix": mix.setMix(v, when); break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        worker?.terminate();
        mix.input.disconnect(); mix.output.disconnect(); preDelay.disconnect(); conv.disconnect(); tone.disconnect();
      },
    };
  },
};

/* ---------------- Delay ---------------- */

const delay: EffectDefinition = {
  type: "delay",
  name: "Delay",
  category: "space",
  params: [
    { id: "time", label: "TIME", min: 30, max: 1000, default: 375, unit: "ms", format: formatMs },
    { id: "feedback", label: "FEEDBK", min: 0, max: 0.9, default: 0.35, format: formatPct },
    { id: "tone", label: "TONE", min: 500, max: 8000, default: 4000, unit: "Hz", format: formatHz },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 0.25, format: formatPct },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const delayNode = ctx.createDelay(2);
    const feedback = ctx.createGain();
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    mix.wet.connect(delayNode);
    delayNode.connect(damp).connect(feedback).connect(delayNode);
    delayNode.connect(mix.output);
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "time": smooth(delayNode.delayTime, v / 1000, when, 0.05); break;
        case "feedback": smooth(feedback.gain, v, when); break;
        case "tone": smooth(damp.frequency, v, when); break;
        case "mix": mix.setMix(v, when); break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => { mix.input.disconnect(); mix.output.disconnect(); delayNode.disconnect(); damp.disconnect(); feedback.disconnect(); },
    };
  },
};

/* ---------------- Pump ---------------- */

export const PUMP_DIVISIONS = [
  { value: 0, label: "1/1", mult: 1 / 4 },
  { value: 1, label: "1/2", mult: 1 / 2 },
  { value: 2, label: "1/4", mult: 1 },
  { value: 3, label: "1/8", mult: 2 },
  { value: 4, label: "1/16", mult: 4 },
];

export function duckCurve(release: number, n = 1024): Float32Array<ArrayBuffer> {
  const k = 3 + release * 15;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    curve[i] = Math.exp(-(i / (n - 1)) * k);
  }
  return curve;
}

const pump: EffectDefinition = {
  type: "pump",
  name: "Pump",
  category: "movement",
  params: [
    { id: "amount", label: "AMOUNT", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "rate", label: "RATE", min: 0, max: PUMP_DIVISIONS.length - 1, default: 2, options: PUMP_DIVISIONS.map(({ value, label }) => ({ value, label })) },
    { id: "release", label: "RELEASE", min: 0, max: 1, default: 0.5, format: formatPct },
  ],
  factory(ctx, instance, env) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const target = ctx.createGain();
    target.gain.value = 1;
    input.connect(target).connect(output);

    const shaper = ctx.createWaveShaper();
    const amt = ctx.createGain();
    const inv = ctx.createGain();
    inv.gain.value = -1;
    shaper.connect(amt).connect(inv).connect(target.gain);

    let bpm = env.bpm;
    let release = instance.params.release ?? 0.5;
    let rateIndex = Math.max(0, Math.min(PUMP_DIVISIONS.length - 1, Math.round(instance.params.rate ?? 2)));
    let osc: OscillatorNode | null = null;

    const freqOf = () => (bpm / 60) * PUMP_DIVISIONS[rateIndex].mult;
    const applyCurve = () => {
      shaper.curve = duckCurve(release);
    };
    const startOsc = (when: number) => {
      if (osc) {
        try { osc.stop(when); } catch { /* not started */ }
        osc.disconnect();
      }
      osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freqOf();
      osc.connect(shaper);
      osc.start(when);
    };

    applyCurve();
    startOsc(0);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "amount": smooth(amt.gain, v, when); break;
        case "rate":
          rateIndex = Math.max(0, Math.min(PUMP_DIVISIONS.length - 1, Math.round(v)));
          if (osc) smooth(osc.frequency, freqOf(), when, 0.05);
          break;
        case "release":
          release = v;
          applyCurve();
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);

    return {
      input,
      output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      syncBpm(next) {
        bpm = next;
        if (osc) smooth(osc.frequency, freqOf(), ctx.currentTime, 0.05);
      },
      onTransportStarted(time, beatPhase) {
        const beatSec = 60 / bpm;
        const nextBeat = time + (1 - beatPhase) * beatSec;
        startOsc(nextBeat);
      },
      dispose: () => {
        if (osc) {
          try { osc.stop(); } catch { /* not started */ }
          osc.disconnect();
        }
        input.disconnect(); output.disconnect(); target.disconnect();
        shaper.disconnect(); amt.disconnect(); inv.disconnect();
      },
    };
  },
};

/* ---------------- Distortion ---------------- */
// Harder-hitting waveshaper than Saturation. Cubic clip curve produces more 3rd-order
// harmonic content for a recognisable "distortion" voice; tone stages the high end.

const distortion: EffectDefinition = {
  type: "distortion",
  name: "Distortion",
  category: "character",
  params: [
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "tone", label: "TONE", min: 500, max: 12000, default: 5000, unit: "Hz", format: formatHz },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
    { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const pre = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "2x";
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    const out = ctx.createGain();
    mix.wet.connect(pre).connect(shaper).connect(tone).connect(out).connect(mix.output);

    let driveVal = 0.4;
    void driveVal; // reserved for future read; curve is the source of truth
    const curveOf = (drive: number): Float32Array<ArrayBuffer> => {
      const k = 1 + drive * 4;
      const n = 2048;
      const curve = new Float32Array(new ArrayBuffer(n * 4));
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        // Cubic soft clip: y = k*x - (k*x)^3 / 3, clamped to [-1, 1]
        const kx = k * x;
        let y = kx - (kx * kx * kx) / 3;
        if (y > 1) y = 1;
        else if (y < -1) y = -1;
        curve[i] = y;
      }
      return curve;
    };
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "drive":
          driveVal = v;
          shaper.curve = curveOf(v);
          break;
        case "tone":
          smooth(tone.frequency, v, when);
          break;
        case "mix":
          mix.setMix(v, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(v), when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        pre.disconnect();
        shaper.disconnect();
        tone.disconnect();
        out.disconnect();
      },
    };
  },
};

/* ---------------- Bitcrusher ---------------- */
// Bit-depth reduction via a stepped WaveShaper curve. `bits` controls the
// number of discrete output levels (2^bits). `downsample` is approximated by
// adjusting the curve's `n` (finer curves for `factor=1` produce the full
// quantised signal; larger factors widen each step, which behaves like a
// quantised ramp) — a coarse but AudioWorklet-free approximation.

const bitcrusher: EffectDefinition = {
  type: "bitcrusher",
  name: "Bitcrusher",
  category: "character",
  params: [
    { id: "bits", label: "BITS", min: 1, max: 16, default: 8, format: (v) => `${v.toFixed(0)} bit` },
    { id: "downsample", label: "CRUSH", min: 1, max: 50, default: 1, format: (v) => `${v.toFixed(0)}x` },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
    { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    // Use AudioWorklet when modules are loaded for THIS context (fixes broken
    // downsample). OfflineAudioContexts must load their own modules first —
    // see loadWorkletModules().
    if (isWorkletReady("bitcrusher", ctx)) {
      return createBitcrusherNode(ctx, instance);
    }
    // Fallback: old WaveShaperNode implementation
    const mix = mixBus(ctx);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "none";
    const out = ctx.createGain();
    mix.wet.connect(shaper).connect(out).connect(mix.output);

    let bitsVal = 8;
    let factorVal = 1;
    const buildCurve = (bits: number, factor: number): Float32Array<ArrayBuffer> => {
      // Curve must be monotonic for WaveShaper; quantise input into discrete
      // steps. n equals the step count so WaveShaper's linear interp between
      // samples doesn't smear the plateau (which would defeat quantisation).
      const steps = Math.max(2, Math.pow(2, Math.max(1, Math.round(bits))));
      const n = steps;
      const curve = new Float32Array(new ArrayBuffer(n * 4));
      const step = 2 / (steps - 1);
      for (let i = 0; i < n; i++) {
        const idx = i;
        const q = -1 + idx * step;
        curve[i] = q;
      }
      // `factor` not used inside the curve math (WaveShaper can't hold a value
      // across samples without a worklet), but we keep it in the closure so
      // the parameter is wired and a future AudioWorklet port can take over.
      void factor;
      return curve;
    };
    shaper.curve = buildCurve(bitsVal, factorVal);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "bits":
          bitsVal = Math.max(1, v);
          shaper.curve = buildCurve(bitsVal, factorVal);
          break;
        case "downsample":
          factorVal = Math.max(1, Math.round(v));
          shaper.curve = buildCurve(bitsVal, factorVal);
          break;
        case "mix":
          mix.setMix(v, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(v), when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      degraded: true,
      degradedReason: "Fallback quality — sample-and-hold downsampling inactive",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        shaper.disconnect();
        out.disconnect();
      },
    };
  },
};

/* ---------------- Chorus ---------------- */
// Two delay lines modulated by independent slow LFOs; both summed into a mix bus.

const chorus: EffectDefinition = {
  type: "chorus",
  name: "Chorus",
  category: "movement",
  params: [
    { id: "rate", label: "RATE", min: 0.1, max: 8, default: 0.6, unit: "Hz", format: (v) => `${v.toFixed(2)} Hz` },
    { id: "depth", label: "DEPTH", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "output", label: "OUTPUT", min: -12, max: 12, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const delay1 = ctx.createDelay(0.05);
    delay1.delayTime.value = 0.012;
    const delay2 = ctx.createDelay(0.05);
    delay2.delayTime.value = 0.018;
    const lfo1 = ctx.createOscillator();
    lfo1.type = "sine";
    lfo1.frequency.value = 0.6;
    const lfo1Depth = ctx.createGain();
    lfo1Depth.gain.value = 0.004;
    lfo1.connect(lfo1Depth).connect(delay1.delayTime);
    lfo1.start();
    const lfo2 = ctx.createOscillator();
    lfo2.type = "sine";
    lfo2.frequency.value = 0.9;
    const lfo2Depth = ctx.createGain();
    lfo2Depth.gain.value = 0.005;
    lfo2.connect(lfo2Depth).connect(delay2.delayTime);
    lfo2.start();
    const d1Mix = ctx.createGain();
    d1Mix.gain.value = 0.5;
    const d2Mix = ctx.createGain();
    d2Mix.gain.value = 0.5;
    mix.wet.connect(delay1).connect(d1Mix).connect(mix.output);
    mix.wet.connect(delay2).connect(d2Mix).connect(mix.output);
    const out = ctx.createGain();
    mix.output.connect(out);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "rate": {
          lfo1.frequency.setTargetAtTime(v, when, 0.05);
          // Second LFO is offset for richer movement
          lfo2.frequency.setTargetAtTime(v * 1.4, when, 0.05);
          break;
        }
        case "depth": {
          const d = 0.001 + v * 0.008;
          lfo1Depth.gain.setTargetAtTime(d, when, 0.05);
          lfo2Depth.gain.setTargetAtTime(d * 1.25, when, 0.05);
          break;
        }
        case "mix":
          mix.setMix(v, when);
          break;
        case "output":
          smooth(out.gain, dbToLin(v), when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: out,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      syncBpm(bpm) {
        // Snap the LFO to 1/4-beat rate (musical default for chorus motion)
        const beatHz = bpm / 60 / 4;
        lfo1.frequency.setTargetAtTime(beatHz, ctx.currentTime, 0.05);
        lfo2.frequency.setTargetAtTime(beatHz * 1.4, ctx.currentTime, 0.05);
      },
      dispose: () => {
        try { lfo1.stop(); } catch { /* not started */ }
        try { lfo2.stop(); } catch { /* not started */ }
        lfo1.disconnect();
        lfo2.disconnect();
        lfo1Depth.disconnect();
        lfo2Depth.disconnect();
        delay1.disconnect();
        delay2.disconnect();
        d1Mix.disconnect();
        d2Mix.disconnect();
        mix.input.disconnect();
        mix.output.disconnect();
        out.disconnect();
      },
    };
  },
};

/* ---------------- Phaser ---------------- */
// Cascade of allpass filters modulated by a single LFO; feedback + dry/wet mix.

const PHASER_STAGE_COUNTS = [2, 4, 6, 8];

const phaser: EffectDefinition = {
  type: "phaser",
  name: "Phaser",
  category: "movement",
  params: [
    { id: "rate", label: "RATE", min: 0.05, max: 8, default: 0.4, unit: "Hz", format: (v) => `${v.toFixed(2)} Hz` },
    { id: "depth", label: "DEPTH", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "feedback", label: "FEEDBK", min: 0, max: 0.9, default: 0.3, format: formatPct },
    { id: "stages", label: "STAGES", min: 0, max: PHASER_STAGE_COUNTS.length - 1, default: 1, options: PHASER_STAGE_COUNTS.map((c, i) => ({ value: i, label: `${c}` })) },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 0.5, format: formatPct },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);

    const buildStages = (count: number): BiquadFilterNode[] => {
      const stages: BiquadFilterNode[] = [];
      for (let i = 0; i < count; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = "allpass";
        ap.frequency.value = 800;
        ap.Q.value = 5;
        stages.push(ap);
      }
      for (let i = 0; i < stages.length - 1; i++) {
        stages[i].connect(stages[i + 1]);
      }
      return stages;
    };

    let stageCount = PHASER_STAGE_COUNTS[Math.max(0, Math.min(PHASER_STAGE_COUNTS.length - 1, Math.round(instance.params.stages ?? 1)))];
    let stages = buildStages(stageCount);

    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.4;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 600;
    lfo.connect(lfoDepth);
    lfo.start();

    const baseGain = ctx.createGain();
    baseGain.gain.value = 800;

    const wireStages = () => {
      // Disconnect any existing fan-out
      try { baseGain.disconnect(); } catch { /* nothing to disconnect */ }
      try { lfoDepth.disconnect(); } catch { /* nothing to disconnect */ }
      for (const stage of stages) {
        baseGain.connect(stage.frequency);
        lfoDepth.connect(stage.frequency);
      }
    };
    wireStages();

    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const wetOut = ctx.createGain();
    wetOut.gain.value = 1;

    // Re-wire: mix.wet -> stages[0] -> ... -> stages[last] -> wetOut -> mix.output
    // and stages[last] -> feedback -> stages[0]
    const connectStages = () => {
      try { mix.wet.disconnect(); } catch { /* nothing */ }
      if (stages.length > 0) {
        mix.wet.connect(stages[0]);
        stages[stages.length - 1].connect(wetOut).connect(mix.output);
        stages[stages.length - 1].connect(feedback).connect(stages[0]);
      } else {
        mix.wet.connect(mix.output);
      }
    };
    connectStages();

    const out = ctx.createGain();
    mix.output.connect(out);

    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "rate":
          lfo.frequency.setTargetAtTime(Math.max(0.05, v), when, 0.05);
          break;
        case "depth":
          lfoDepth.gain.setTargetAtTime(1500 * v, when, 0.05);
          break;
        case "feedback":
          smooth(feedback.gain, v, when);
          break;
        case "stages": {
          const idx = Math.max(0, Math.min(PHASER_STAGE_COUNTS.length - 1, Math.round(v)));
          const newCount = PHASER_STAGE_COUNTS[idx];
          if (newCount === stageCount) return;
          // Tear down old chain
          try { mix.wet.disconnect(); } catch { /* nothing */ }
          for (const stage of stages) {
            try { stage.disconnect(); } catch { /* nothing */ }
          }
          try { feedback.disconnect(); } catch { /* nothing */ }
          try { wetOut.disconnect(); } catch { /* nothing */ }
          stageCount = newCount;
          stages = buildStages(stageCount);
          wireStages();
          connectStages();
          break;
        }
        case "mix":
          mix.setMix(v, when);
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: out,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => {
        try { lfo.stop(); } catch { /* not started */ }
        lfo.disconnect();
        lfoDepth.disconnect();
        baseGain.disconnect();
        feedback.disconnect();
        wetOut.disconnect();
        for (const stage of stages) {
          try { stage.disconnect(); } catch { /* already */ }
        }
        mix.input.disconnect();
        mix.output.disconnect();
        out.disconnect();
      },
    };
  },
};

/* ---------------- Sidechain Compressor ---------------- */
// Ducks the main signal's gain based on the envelope of a separate audio source.
// Web Audio's DynamicsCompressorNode has no sidechain input, and ScriptProcessorNode
// is unreliable in OfflineAudioContext (which is what offline render + our
// browser-checks use). So we route the sidechain source through an AnalyserNode
// and run a JS-side envelope follower that writes `target.gain` via
// `setTargetAtTime`. This works in both realtime and offline contexts; the
// analysis is main-thread, not audio-rate, so ducking granularity is bounded
// by the JS timer — fine for musical sidechain but not for sub-10 ms precision.

const SIDE_UPDATE_MS = 10; // envelope refresh interval

const sidechain: EffectDefinition = {
  type: "sidechain",
  name: "Sidechain",
  category: "dynamics",
  params: [
    { id: "threshold", label: "THRESH", min: -60, max: 0, default: -18, unit: "dB", format: formatDb },
    { id: "ratio", label: "RATIO", min: 1, max: 20, default: 4, format: (v) => `${v.toFixed(1)}:1` },
    { id: "attack", label: "ATTACK", min: 0.001, max: 0.5, default: 0.005, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.02, max: 1, default: 0.2, unit: "s", format: formatMs },
    { id: "amount", label: "AMOUNT", min: 0, max: 1, default: 1, format: formatPct },
  ],
  factory(ctx, instance) {
    // Use AudioWorklet when modules are loaded for THIS context (audio-rate
    // envelope, offline-safe)
    if (isWorkletReady("sidechain", ctx)) {
      return createSidechainNode(ctx, instance);
    }
    // Fallback: old setInterval + AnalyserNode implementation
    const input = ctx.createGain();
    const output = ctx.createGain();
    const target = ctx.createGain();
    target.gain.value = 1;
    input.connect(target).connect(output);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    const analyserBuf = new Float32Array(analyser.fftSize);

    let env = 0;
    let thresholdLin = Math.pow(10, -18 / 20);
    let ratio = 4;
    let amount = 1;
    let attackCoef = Math.exp(-1 / (ctx.sampleRate * 0.005));
    let releaseCoef = Math.exp(-1 / (ctx.sampleRate * 0.2));
    let sidechainNode: AudioNode | null = null;
    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const computeTargetGain = (): number => {
      if (sidechainNode === null) return 1;
      // Read current peak from the analyser buffer.
      analyser.getFloatTimeDomainData(analyserBuf);
      let peak = 0;
      for (let i = 0; i < analyserBuf.length; i++) {
        const v = Math.abs(analyserBuf[i]);
        if (v > peak) peak = v;
      }
      // Asymmetric envelope follower
      env = peak > env
        ? attackCoef * env + (1 - attackCoef) * peak
        : releaseCoef * env + (1 - releaseCoef) * peak;
      const envDb = 20 * Math.log10(Math.max(env, 1e-7));
      const threshDb = 20 * Math.log10(Math.max(thresholdLin, 1e-7));
      const overDb = Math.max(0, envDb - threshDb);
      const reductionDb = overDb * (1 - 1 / Math.max(1, ratio));
      const reduction = Math.pow(10, -reductionDb / 20);
      return Math.max(0, 1 - amount * (1 - reduction));
    };

    const tick = () => {
      if (!active) return;
      const g = computeTargetGain();
      target.gain.setTargetAtTime(g, ctx.currentTime, 0.005);
    };
    if (typeof setInterval === "function") {
      interval = setInterval(tick, SIDE_UPDATE_MS);
    }

    const apply = (id: string, v: number, _when: number) => {
      switch (id) {
        case "threshold":
          thresholdLin = Math.pow(10, v / 20);
          break;
        case "ratio":
          ratio = v;
          break;
        case "attack":
          attackCoef = Math.exp(-1 / (ctx.sampleRate * Math.max(0.001, v)));
          break;
        case "release":
          releaseCoef = Math.exp(-1 / (ctx.sampleRate * Math.max(0.001, v)));
          break;
        case "amount":
          amount = v;
          break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);

    return {
      input,
      output,
      degraded: true,
      degradedReason: "Fallback — 100 Hz envelope ducking (inactive in offline renders)",
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      setSidechainInput(node: AudioNode | null) {
        if (sidechainNode) {
          try { sidechainNode.disconnect(analyser); } catch { /* not connected */ }
        }
        sidechainNode = node;
        if (node) {
          env = 0;
          node.connect(analyser);
        } else {
          // When sidechain is removed, restore the target gain to neutral.
          target.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
        }
      },
      dispose: () => {
        active = false;
        if (interval !== null) {
          clearInterval(interval);
          interval = null;
        }
        if (sidechainNode) {
          try { sidechainNode.disconnect(analyser); } catch { /* not connected */ }
          sidechainNode = null;
        }
        try { analyser.disconnect(); } catch { /* already disconnected */ }
        input.disconnect();
        target.disconnect();
        output.disconnect();
      },
    };
  },
};

/* ---------------- Core dynamics and utility ---------------- */

function createWorkletRuntime(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  processor: "transient-processor" | "gate-processor",
  readyType: "transient" | "gate",
): EffectRuntime | null {
  if (!isWorkletReady(readyType, ctx)) return null;
  const node = new AudioWorkletNode(ctx, processor, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2 });
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);
  const apply = (id: string, value: number, when: number) => {
    const param = node.parameters.get(id);
    if (param) param.setValueAtTime(value, when);
  };
  for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
  return {
    input,
    output,
    setParameter: (id, value) => apply(id, value, ctx.currentTime),
    setParameterAt: apply,
    dispose: () => { node.disconnect(); input.disconnect(); output.disconnect(); },
  };
}

const transient: EffectDefinition = {
  type: "transient",
  name: "Transient Shaper",
  category: "dynamics",
  params: [
    { id: "attack", label: "ATTACK", min: -1, max: 1, default: 0.25, format: formatPct },
    { id: "sustain", label: "SUSTAIN", min: -1, max: 1, default: 0, format: formatPct },
    { id: "sensitivity", label: "SENSITIVITY", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
    { id: "output", label: "OUTPUT", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    const worklet = createWorkletRuntime(ctx, instance, "transient-processor", "transient");
    if (worklet) return worklet;
    // Transparent 1:1 bypass when AudioWorklet is unavailable — never silence,
    // always flagged so the UI can warn (see effectProcessorStatus).
    return bypassRuntime(ctx, "AudioWorklet unavailable — transient shaper bypassed (1:1 signal)");
  },
};

const gate: EffectDefinition = {
  type: "gate",
  name: "Gate",
  category: "dynamics",
  params: [
    { id: "threshold", label: "THRESH", min: -80, max: 0, default: -36, unit: "dB", format: formatDb },
    { id: "attack", label: "ATTACK", min: 0.0001, max: 0.5, default: 0.002, unit: "s", format: formatMs },
    { id: "hold", label: "HOLD", min: 0, max: 1, default: 0.02, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.001, max: 2, default: 0.08, unit: "s", format: formatMs },
    { id: "range", label: "RANGE", min: -80, max: 0, default: -48, unit: "dB", format: formatDb },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  ],
  factory(ctx, instance) {
    const worklet = createWorkletRuntime(ctx, instance, "gate-processor", "gate");
    if (worklet) return worklet;
    // Transparent 1:1 bypass fallback — the gate never silently stops gating
    // without the UI knowing (degraded flag → warning badge).
    return bypassRuntime(ctx, "AudioWorklet unavailable — gate bypassed (1:1 signal)");
  },
};

function bussCurve(drive: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(2048 * 4));
  const k = 1 + drive * 18;
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k);
  }
  return curve;
}

const drumBuss: EffectDefinition = {
  type: "drumBuss",
  name: "Drum Buss",
  category: "character",
  params: [
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.22, format: formatPct },
    { id: "transient", label: "TRANSIENT", min: -1, max: 1, default: 0.15, format: formatPct },
    { id: "compressor", label: "COMPRESSOR", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "tone", label: "TONE", min: 300, max: 16000, default: 9000, unit: "Hz", format: formatHz },
    { id: "boomFrequency", label: "BOOM FREQ", min: 30, max: 160, default: 60, unit: "Hz", format: formatHz },
    { id: "boomAmount", label: "BOOM", min: 0, max: 1, default: 0.12, format: formatPct },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
    { id: "output", label: "OUTPUT", min: -18, max: 18, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "2x";
    const comp = ctx.createDynamicsCompressor();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    const boom = ctx.createBiquadFilter();
    boom.type = "lowshelf";
    const out = ctx.createGain();
    mix.wet.connect(shaper).connect(comp).connect(tone).connect(boom).connect(out).connect(mix.output);
    const apply = (id: string, value: number, when: number) => {
      switch (id) {
        case "drive": shaper.curve = bussCurve(value); break;
        case "transient": smooth(comp.attack, Math.max(0.001, 0.02 - value * 0.015), when); break;
        case "compressor": smooth(comp.threshold, -6 - value * 34, when); smooth(comp.ratio, 1 + value * 9, when); break;
        case "tone": smooth(tone.frequency, value, when); break;
        case "boomFrequency": smooth(boom.frequency, value, when); break;
        case "boomAmount": smooth(boom.gain, value * 8, when); break;
        case "mix": mix.setMix(value, when); break;
        case "output": smooth(out.gain, dbToLin(value), when); break;
      }
    };
    for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
    return { input: mix.input, output: mix.output, setParameter: (id, value) => apply(id, value, ctx.currentTime), setParameterAt: (id, value, when) => apply(id, value, when), dispose: () => { mix.input.disconnect(); mix.output.disconnect(); shaper.disconnect(); comp.disconnect(); tone.disconnect(); boom.disconnect(); out.disconnect(); } };
  },
};

const bassBuss: EffectDefinition = {
  type: "bassBuss",
  name: "Bass Buss",
  category: "character",
  params: [
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.16, format: formatPct },
    { id: "subEnhance", label: "SUB", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "subFrequency", label: "SUB FREQ", min: 20, max: 160, default: 70, unit: "Hz", format: formatHz },
    { id: "compression", label: "COMPRESSION", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 0.2, default: 0.01, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.02, max: 1, default: 0.18, unit: "s", format: formatMs },
    { id: "monoBassFrequency", label: "MONO BASS", min: 0, max: 160, default: 100, unit: "Hz", format: (v) => v <= 0 ? "OFF" : formatHz(v) },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
    { id: "output", label: "OUTPUT", min: -18, max: 18, default: 0, unit: "dB", format: formatDb },
  ],
  factory(ctx, instance) {
    const mix = mixBus(ctx);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "2x";
    const comp = ctx.createDynamicsCompressor();
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    const out = ctx.createGain();
    // Mono-bass crossover: below MONO BASS the summed (L+R)/2 lows feed BOTH
    // outputs — a true mono sub — while highs keep their stereo placement.
    // monoBassFrequency ≤ 0 routes everything through the untouched direct
    // path (the crossover idles at 20 Hz).
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const hpL = ctx.createBiquadFilter();
    const hpR = ctx.createBiquadFilter();
    const lpL = ctx.createBiquadFilter();
    const lpR = ctx.createBiquadFilter();
    hpL.type = "highpass";
    hpR.type = "highpass";
    lpL.type = "lowpass";
    lpR.type = "lowpass";
    hpL.frequency.value = 20;
    hpR.frequency.value = 20;
    lpL.frequency.value = 20;
    lpR.frequency.value = 20;
    const monoSum = ctx.createGain();
    monoSum.gain.value = 0;
    const crossoverGain = ctx.createGain();
    crossoverGain.gain.value = 0;
    const directGain = ctx.createGain();
    directGain.gain.value = 1;
    mix.wet.connect(shaper).connect(comp).connect(low).connect(out);
    out.connect(directGain).connect(mix.output);
    out.connect(splitter);
    splitter.connect(hpL, 0);
    splitter.connect(hpR, 1);
    splitter.connect(lpL, 0);
    splitter.connect(lpR, 1);
    lpL.connect(monoSum);
    lpR.connect(monoSum);
    monoSum.connect(merger, 0, 0);
    monoSum.connect(merger, 0, 1);
    hpL.connect(merger, 0, 0);
    hpR.connect(merger, 0, 1);
    merger.connect(crossoverGain).connect(mix.output);
    const apply = (id: string, value: number, when: number) => {
      switch (id) {
        case "drive": shaper.curve = bussCurve(value); break;
        case "subEnhance": smooth(low.gain, value * 8, when); break;
        case "subFrequency": smooth(low.frequency, value, when); break;
        case "compression": smooth(comp.threshold, -8 - value * 32, when); smooth(comp.ratio, 1 + value * 7, when); break;
        case "attack": smooth(comp.attack, value, when); break;
        case "release": smooth(comp.release, value, when); break;
        case "monoBassFrequency": {
          const active = value > 0;
          const frequency = Math.max(20, value || 20);
          smooth(hpL.frequency, frequency, when);
          smooth(hpR.frequency, frequency, when);
          smooth(lpL.frequency, frequency, when);
          smooth(lpR.frequency, frequency, when);
          smooth(monoSum.gain, active ? 0.5 : 0, when);
          smooth(crossoverGain.gain, active ? 1 : 0, when);
          smooth(directGain.gain, active ? 0 : 1, when);
          break;
        }
        case "mix": mix.setMix(value, when); break;
        case "output": smooth(out.gain, dbToLin(value), when); break;
      }
    };
    for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, value) => apply(id, value, ctx.currentTime),
      setParameterAt: (id, value, when) => apply(id, value, when),
      dispose: () => {
        mix.input.disconnect();
        mix.output.disconnect();
        shaper.disconnect();
        comp.disconnect();
        low.disconnect();
        out.disconnect();
        splitter.disconnect();
        merger.disconnect();
        hpL.disconnect();
        hpR.disconnect();
        lpL.disconnect();
        lpR.disconnect();
        monoSum.disconnect();
        crossoverGain.disconnect();
        directGain.disconnect();
      },
    };
  },
};

const utility: EffectDefinition = {
  type: "utility",
  name: "Utility",
  category: "tone",
  params: [
    { id: "gain", label: "GAIN", min: -24, max: 24, default: 0, unit: "dB", format: formatDb },
    { id: "pan", label: "PAN", min: -1, max: 1, default: 0, format: (v) => Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}` },
    { id: "width", label: "WIDTH", min: 0, max: 2, default: 1, format: (v) => `${Math.round(v * 100)}%` },
    { id: "monoBassFrequency", label: "MONO BASS", min: 0, max: 200, default: 0, unit: "Hz", format: (v) => v <= 0 ? "OFF" : formatHz(v) },
    { id: "phaseLeft", label: "PHASE L", min: 0, max: 1, default: 0, options: [{ value: 0, label: "NORMAL" }, { value: 1, label: "INVERT" }] },
    { id: "phaseRight", label: "PHASE R", min: 0, max: 1, default: 0, options: [{ value: 0, label: "NORMAL" }, { value: 1, label: "INVERT" }] },
  ],
  factory(ctx, instance) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const left = ctx.createGain();
    const right = ctx.createGain();
    const crossLeft = ctx.createGain();
    const crossRight = ctx.createGain();
    const highLeft = ctx.createBiquadFilter();
    const highRight = ctx.createBiquadFilter();
    const lowLeft = ctx.createBiquadFilter();
    const lowRight = ctx.createBiquadFilter();
    highLeft.type = "highpass";
    highRight.type = "highpass";
    lowLeft.type = "lowpass";
    lowRight.type = "lowpass";
    const monoLeft = ctx.createGain();
    const monoRight = ctx.createGain();
    input.connect(splitter);
    splitter.connect(highLeft, 0);
    splitter.connect(highRight, 1);
    highLeft.connect(left).connect(merger, 0, 0);
    highRight.connect(right).connect(merger, 0, 1);
    highLeft.connect(crossLeft).connect(merger, 0, 1);
    highRight.connect(crossRight).connect(merger, 0, 0);
    // True mono low band: (L + R) × 0.5 feeds BOTH outputs. The previous
    // wiring kept the lows per-channel (attenuated but still stereo), so the
    // "MONO BASS" control never actually mono-ed anything.
    splitter.connect(lowLeft, 0).connect(monoLeft);
    splitter.connect(lowRight, 1).connect(monoRight);
    monoLeft.connect(merger, 0, 0);
    monoLeft.connect(merger, 0, 1);
    monoRight.connect(merger, 0, 0);
    monoRight.connect(merger, 0, 1);
    const pan = ctx.createStereoPanner();
    merger.connect(pan).connect(output);
    let widthValue = instance.params.width ?? 1;
    let phaseLeft = instance.params.phaseLeft === 1;
    let phaseRight = instance.params.phaseRight === 1;
    const applyWidth = (when: number) => {
      const width = Math.max(0, Math.min(2, widthValue));
      smooth(left.gain, ((1 + width) / 2) * (phaseLeft ? -1 : 1), when);
      smooth(right.gain, ((1 + width) / 2) * (phaseRight ? -1 : 1), when);
      smooth(crossLeft.gain, (1 - width) / 2, when);
      smooth(crossRight.gain, (1 - width) / 2, when);
    };
    const apply = (id: string, value: number, when: number) => {
      switch (id) {
        case "gain": smooth(output.gain, dbToLin(value), when); break;
        case "pan": smooth(pan.pan, value, when); break;
        case "width": {
          widthValue = value;
          applyWidth(when);
          break;
        }
        case "phaseLeft": phaseLeft = value >= 0.5; applyWidth(when); break;
        case "phaseRight": phaseRight = value >= 0.5; applyWidth(when); break;
        case "monoBassFrequency": {
          const frequency = Math.max(20, value || 20);
          smooth(highLeft.frequency, frequency, when);
          smooth(highRight.frequency, frequency, when);
          smooth(lowLeft.frequency, frequency, when);
          smooth(lowRight.frequency, frequency, when);
          const active = value > 0 ? 0.5 : 0;
          smooth(monoLeft.gain, active, when);
          smooth(monoRight.gain, active, when);
          break;
        }
      }
    };
    for (const [id, value] of Object.entries(instance.params)) apply(id, value, ctx.currentTime);
    return { input, output, setParameter: (id, value) => apply(id, value, ctx.currentTime), setParameterAt: (id, value, when) => apply(id, value, when), dispose: () => { input.disconnect(); output.disconnect(); splitter.disconnect(); merger.disconnect(); left.disconnect(); right.disconnect(); crossLeft.disconnect(); crossRight.disconnect(); highLeft.disconnect(); highRight.disconnect(); lowLeft.disconnect(); lowRight.disconnect(); monoLeft.disconnect(); monoRight.disconnect(); pan.disconnect(); } };
  },
};

/* ---------------- Look-ahead Limiter ---------------- */
// True brickwall limiting: a monotonic max-deque over the look-ahead window
// lets gain changes precede transients, so peaks never exceed CEILING (unlike
// the native master DynamicsCompressorNode with its 2 ms attack). Latency =
// exactly LOOKAHEAD — reported via getLatencySec and compensated by the
// engine's PDC. LOOKAHEAD defaults to 5 ms; drop it to 1 ms for insert use on
// individual tracks where minimal latency matters more than anticipation.

const limiter: EffectDefinition = {
  type: "limiter",
  name: "Limiter",
  category: "dynamics",
  params: [
    { id: "ceiling", label: "CEILING", min: -12, max: 0, default: -1, unit: "dB", format: formatDb },
    { id: "threshold", label: "THRESHOLD", min: -24, max: 0, default: -6, unit: "dB", format: formatDb },
    { id: "release", label: "RELEASE", min: 0.01, max: 1, default: 0.12, unit: "s", format: formatMs },
    { id: "lookaheadMs", label: "LOOKAHEAD", min: 1, max: 20, default: 5, unit: "ms", format: formatMs },
    { id: "link", label: "LINK", min: 0, max: 1, default: 1, format: formatPct },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  ],
  factory(ctx, instance) {
    if (isWorkletReady("limiter", ctx)) return createLimiterNode(ctx, instance);
    // Transparent 1:1 bypass fallback — never fake-limit, always warn.
    return bypassRuntime(ctx, "AudioWorklet unavailable — limiter bypassed (1:1 signal)");
  },
};

/* ---------------- registry ---------------- */

export const EFFECT_DEFS: Record<EffectType, EffectDefinition> = {
  eq,
  compressor,
  saturation,
  clipper,
  limiter,
  reverb,
  delay,
  pump,
  distortion,
  bitcrusher,
  chorus,
  phaser,
  sidechain,
  transient,
  drumBuss,
  bassBuss,
  utility,
  gate,
};

export const EFFECT_ORDER: EffectType[] = [
  "eq",
  "compressor",
  "saturation",
  "clipper",
  "limiter",
  "reverb",
  "delay",
  "pump",
  "distortion",
  "bitcrusher",
  "chorus",
  "phaser",
  "sidechain",
  "transient",
  "drumBuss",
  "bassBuss",
  "utility",
  "gate",
];

/** Effects intentionally exposed in the new mixer Add Effect menu. */
export const CORE_EFFECT_ORDER: EffectType[] = [
  "eq",
  "transient",
  "limiter",
  "drumBuss",
  "bassBuss",
  "utility",
  "gate",
  "sidechain",
  "chorus",
];

export function defaultParamsOf(type: EffectType): Record<string, number> {
  return Object.fromEntries(EFFECT_DEFS[type].params.map((p) => [p.id, p.default]));
}

export function clampEffectParam(type: EffectType, paramId: string, value: number): number {
  const def: ParamDef | undefined = EFFECT_DEFS[type].params.find((p) => p.id === paramId);
  if (!def) return value;
  return Math.min(def.max, Math.max(def.min, value));
}
