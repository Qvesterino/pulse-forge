import type { EffectDefinition, ParamDef } from "./types";
import type { EffectType } from "../project-model/types";
import { hashString, mulberry32 } from "../shared/rng";

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

/* ---------------- EQ ---------------- */

const eq: EffectDefinition = {
  type: "eq",
  name: "EQ",
  category: "tone",
  params: [
    { id: "lowGain", label: "LOW", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "lowFreq", label: "LOW FREQ", min: 40, max: 400, default: 120, unit: "Hz", format: formatHz },
    { id: "midGain", label: "MID", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "midFreq", label: "MID FREQ", min: 200, max: 4000, default: 1000, unit: "Hz", format: formatHz },
    { id: "midQ", label: "MID Q", min: 0.3, max: 8, default: 1, format: (v) => v.toFixed(2) },
    { id: "highGain", label: "HIGH", min: -15, max: 15, default: 0, unit: "dB", format: formatDb },
    { id: "highFreq", label: "HIGH FREQ", min: 1500, max: 12000, default: 6000, unit: "Hz", format: formatHz },
  ],
  factory(ctx, instance) {
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    low.connect(mid).connect(high);
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "lowGain": smooth(low.gain, v, when); break;
        case "lowFreq": smooth(low.frequency, v, when); break;
        case "midGain": smooth(mid.gain, v, when); break;
        case "midFreq": smooth(mid.frequency, v, when); break;
        case "midQ": smooth(mid.Q, v, when); break;
        case "highGain": smooth(high.gain, v, when); break;
        case "highFreq": smooth(high.frequency, v, when); break;
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: low,
      output: high,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
      dispose: () => { low.disconnect(); mid.disconnect(); high.disconnect(); },
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
    { id: "makeup", label: "MAKEUP", min: 0, max: 24, default: 0, unit: "dB", format: formatDb },
    { id: "mix", label: "MIX", min: 0, max: 1, default: 1, format: formatPct },
  ],
  factory(ctx, instance) {
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
      }
    };
    for (const [k, v] of Object.entries(instance.params)) apply(k, v, ctx.currentTime);
    return {
      input: mix.input,
      output: mix.output,
      setParameter: (id, v) => apply(id, v, ctx.currentTime),
      setParameterAt: (id, v, when) => apply(id, v, when),
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
    const apply = (id: string, v: number, when: number) => {
      switch (id) {
        case "decay": conv.buffer = makeImpulseResponse(ctx, v, seed); break;
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
      dispose: () => { mix.input.disconnect(); mix.output.disconnect(); preDelay.disconnect(); conv.disconnect(); tone.disconnect(); },
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

/* ---------------- registry ---------------- */

export const EFFECT_DEFS: Record<EffectType, EffectDefinition> = {
  eq,
  compressor,
  saturation,
  clipper,
  reverb,
  delay,
  pump,
};

export const EFFECT_ORDER: EffectType[] = ["eq", "compressor", "saturation", "clipper", "reverb", "delay", "pump"];

export function defaultParamsOf(type: EffectType): Record<string, number> {
  return Object.fromEntries(EFFECT_DEFS[type].params.map((p) => [p.id, p.default]));
}

export function clampEffectParam(type: EffectType, paramId: string, value: number): number {
  const def: ParamDef | undefined = EFFECT_DEFS[type].params.find((p) => p.id === paramId);
  if (!def) return value;
  return Math.min(def.max, Math.max(def.min, value));
}
