import type { InstrumentDefinition, InstrumentRuntime } from "./types";
import type { InstrumentKind, InstrumentTrack } from "../project-model/types";
import { midiToFreq } from "../project-model/types";
import type { ParamDef } from "../effects/types";
import { hashString, mulberry32 } from "../shared/rng";

const WAVE_NAMES = ["sine", "triangle", "sawtooth", "square"] as const;

const WAVE_OPTIONS = [
  { value: 0, label: "Sine" },
  { value: 1, label: "Tri" },
  { value: 2, label: "Saw" },
  { value: 3, label: "Sqr" },
];

const formatDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const formatHz = (v: number) => `${Math.round(v)} Hz`;
const formatMs = (v: number) => `${Math.round(v * 1000)} ms`;
const formatPct = (v: number) => `${Math.round(v * 100)}%`;

function noiseBuffer(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(seed);
  for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
  return buffer;
}

function tanhCurve(k: number, n = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k);
  }
  return curve;
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

interface Voice {
  stopAt: number;
  stop(when: number): void;
  silence(now: number): void;
}

function makeVoiceManager(limit: number) {
  const voices: Voice[] = [];
  const register = (stopAt: number, stop: (when: number) => void, silence: (now: number) => void): Voice => {
    const voice: Voice = { stopAt, stop, silence };
    voices.push(voice);
    if (voices.length > limit) {
      const oldest = voices.shift();
      oldest?.stop(0);
    }
    return voice;
  };
  const cleanup = (voice: Voice) => {
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
  };
  return { voices, register, cleanup };
}

/* ---------------- Analog Synth ---------------- */

const analog: InstrumentDefinition = {
  kind: "analog",
  name: "Analog Synth",
  params: [
    { id: "oscA", label: "OSC A", min: 0, max: 3, default: 2, options: WAVE_OPTIONS },
    { id: "oscB", label: "OSC B", min: 0, max: 3, default: 2, options: WAVE_OPTIONS },
    { id: "oscBDetune", label: "DETUNE", min: -50, max: 50, default: 8, unit: "ct", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct` },
    { id: "subLevel", label: "SUB", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "noiseLevel", label: "NOISE", min: 0, max: 0.5, default: 0.04, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 9000, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 12, default: 1, format: (v) => v.toFixed(2) },
    { id: "filterEnv", label: "FLT ENV", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.01, unit: "s", format: formatMs },
    { id: "decay", label: "DECAY", min: 0.02, max: 3, default: 0.25, unit: "s", format: formatMs },
    { id: "sustain", label: "SUSTAIN", min: 0, max: 1, default: 0.7, format: formatPct },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.2, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const noise = noiseBuffer(ctx, hashString(track.id));
    const p = { ...track.params };
    const { voices, register, cleanup } = makeVoiceManager(12);

    const liveFilters = new Set<BiquadFilterNode>();
    const applyFilterLive = (fn: (f: BiquadFilterNode) => void) => {
      for (const f of liveFilters) fn(f);
    };

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const freq = midiToFreq(pitch);
        const attack = Math.max(0.002, p.attack ?? 0.01);
        const decay = Math.max(0.02, p.decay ?? 0.25);
        const sustain = Math.max(0, Math.min(1, p.sustain ?? 0.7));
        const release = Math.max(0.01, p.release ?? 0.2);
        const hold = Math.max(durationSec, attack + 0.01);
        const off = when + hold;
        const stopTime = off + release * 2 + 0.1;

        const amp = ctx.createGain();
        const peak = velocity * dbToLin(p.level ?? -6);
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
        amp.gain.setTargetAtTime(Math.max(peak * sustain, 0.0002), when + attack, decay / 3);
        amp.gain.setTargetAtTime(0.0001, off, release / 4);
        amp.connect(output);

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        const base = p.cutoff ?? 9000;
        const peakCut = Math.min(18000, base + (p.filterEnv ?? 0.3) * velocity * 6000);
        filter.frequency.setValueAtTime(Math.max(40, base * 0.6), when);
        filter.frequency.linearRampToValueAtTime(peakCut, when + attack);
        filter.frequency.setTargetAtTime(base, when + attack, decay / 3);
        filter.Q.value = p.resonance ?? 1;
        filter.connect(amp);
        liveFilters.add(filter);

        const oscs: OscillatorNode[] = [];
        const mkOsc = (waveIndex: number, detune: number, level: number, transpose = 0) => {
          const osc = ctx.createOscillator();
          osc.type = WAVE_NAMES[Math.max(0, Math.min(3, Math.round(waveIndex)))];
          osc.frequency.value = freq * Math.pow(2, transpose / 12);
          osc.detune.value = detune;
          const g = ctx.createGain();
          g.gain.value = level;
          osc.connect(g).connect(filter);
          osc.start(when);
          osc.stop(stopTime);
          oscs.push(osc);
        };
        mkOsc(p.oscA ?? 2, 0, 0.5);
        mkOsc(p.oscB ?? 2, p.oscBDetune ?? 8, 0.5 * 0.9);
        mkOsc(0, 0, (p.subLevel ?? 0.25) * 0.8, -12);
        if ((p.noiseLevel ?? 0) > 0.0005) {
          const src = ctx.createBufferSource();
          src.buffer = noise;
          src.loop = true;
          const g = ctx.createGain();
          g.gain.value = p.noiseLevel ?? 0;
          src.connect(g).connect(filter);
          src.start(when);
          src.stop(stopTime);
        }

        const voice = register(
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            for (const osc of oscs) {
              try { osc.stop(t + 0.05); } catch { /* already stopped */ }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
          },
        );
        const latest = oscs[oscs.length - 1];
        if (latest) latest.onended = () => {
          liveFilters.delete(filter);
          amp.disconnect();
          filter.disconnect();
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff") applyFilterLive((f) => f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02));
        if (id === "resonance") applyFilterLive((f) => f.Q.setTargetAtTime(value, ctx.currentTime, 0.02));
      },
      panic() {
        for (const voice of [...voices]) voice.silence(ctx.currentTime);
        voices.length = 0;
        liveFilters.clear();
      },
      dispose() {
        this.panic();
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- Bass Synth ---------------- */

const bass: InstrumentDefinition = {
  kind: "bass",
  name: "Bass Synth",
  params: [
    { id: "sub", label: "SUB", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.7, format: formatPct },
    { id: "punch", label: "PUNCH", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "grit", label: "GRIT", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "movement", label: "MOVE", min: 0, max: 1, default: 0.15, format: formatPct },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 4000, default: 700, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 10, default: 1.2, format: (v) => v.toFixed(2) },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const { voices, register, cleanup } = makeVoiceManager(4);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "2x";
    const applyGrit = () => {
      shaper.curve = tanhCurve(1 + (p.grit ?? 0.25) * 8);
    };
    applyGrit();
    shaper.connect(output);
    const liveFilters = new Set<BiquadFilterNode>();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const freq = midiToFreq(pitch);
        const width = p.width ?? 0.2;
        const hold = Math.max(durationSec, 0.03);
        const off = when + hold;
        const release = 0.1;
        const stopTime = off + release * 2 + 0.1;
        const level = velocity * dbToLin(p.level ?? -6);

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), when + 0.003);
        amp.gain.setTargetAtTime(Math.max(level * 0.72, 0.0002), when + 0.003, 0.12);
        amp.gain.setTargetAtTime(0.0001, off, release / 4);
        amp.connect(shaper);

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        const base = p.cutoff ?? 700;
        const punch = p.punch ?? 0.5;
        const peakCut = Math.min(8000, base + 400 + punch * 3600 * velocity);
        filter.frequency.setValueAtTime(Math.max(50, base), when);
        filter.frequency.linearRampToValueAtTime(peakCut, when + 0.003);
        filter.frequency.setTargetAtTime(base, when + 0.003, (0.1 + punch * 0.12) / 1);
        filter.Q.value = p.resonance ?? 1.2;
        filter.connect(amp);
        liveFilters.add(filter);

        if ((p.movement ?? 0) > 0.005) {
          const lfo = ctx.createOscillator();
          lfo.type = "sine";
          lfo.frequency.value = 3.5;
          const depth = ctx.createGain();
          depth.gain.value = (p.movement ?? 0) * 700;
          lfo.connect(depth).connect(filter.frequency);
          lfo.start(when);
          lfo.stop(stopTime);
        }

        const oscs: OscillatorNode[] = [];
        const mkVoiceOsc = (detuneCents: number, levelGain: number, panValue: number, type: OscillatorType, transpose = 0) => {
          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.value = freq * Math.pow(2, transpose / 12);
          osc.detune.value = detuneCents;
          const g = ctx.createGain();
          g.gain.value = levelGain;
          const pan = ctx.createStereoPanner();
          pan.pan.value = panValue;
          osc.connect(g).connect(pan).connect(filter);
          osc.start(when);
          osc.stop(stopTime);
          oscs.push(osc);
        };
        const bodyLevel = 0.2 + (p.body ?? 0.7) * 0.4;
        mkVoiceOsc(0, bodyLevel * 0.7, -width, "sawtooth");
        mkVoiceOsc(width * 25, bodyLevel * 0.7, width, "square");
        mkVoiceOsc(0, (p.sub ?? 0.6) * 1.0, 0, "sine", -12);

        const voice = register(
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            for (const osc of oscs) {
              try { osc.stop(t + 0.05); } catch { /* already stopped */ }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
          },
        );
        const last = oscs[oscs.length - 1];
        if (last) last.onended = () => {
          liveFilters.delete(filter);
          amp.disconnect();
          filter.disconnect();
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
        if (id === "resonance") for (const f of liveFilters) f.Q.setTargetAtTime(value, ctx.currentTime, 0.02);
        if (id === "grit") applyGrit();
      },
      panic() {
        for (const voice of [...voices]) voice.silence(ctx.currentTime);
        voices.length = 0;
        liveFilters.clear();
      },
      dispose() {
        this.panic();
        shaper.disconnect();
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- 808 Synth ---------------- */

const bass808: InstrumentDefinition = {
  kind: "808",
  name: "808 Synth",
  params: [
    { id: "decay", label: "DECAY", min: 0.05, max: 4, default: 0.9, unit: "s", format: (v) => `${v.toFixed(2)} s` },
    { id: "pitchDrop", label: "P-DROP", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "click", label: "CLICK", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "tone", label: "TONE", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.85, format: formatPct },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const noise = noiseBuffer(ctx, hashString(track.id) ^ 0x5f5f);
    const shaper = ctx.createWaveShaper();
    shaper.oversample = "2x";
    shaper.curve = tanhCurve(2.5);
    shaper.connect(output);
    let current: Voice | null = null;

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, _durationSec) {
        current?.stop(when);
        const freq = midiToFreq(pitch);
        const decay = Math.max(0.05, p.decay ?? 0.9);
        const drop = p.pitchDrop ?? 0.4;
        const toneHz = 150 * Math.pow(2, (p.tone ?? 0.35) * 5.5);
        const gainVal = velocity * (p.gain ?? 0.85);
        const stopTime = when + decay + 0.6;

        const pre = ctx.createGain();
        pre.gain.value = 1 + (p.drive ?? 0.25) * 4;
        const post = ctx.createGain();
        post.gain.value = 0.8;
        pre.connect(shaper);

        const toneFilter = ctx.createBiquadFilter();
        toneFilter.type = "lowpass";
        toneFilter.frequency.value = Math.max(120, toneHz);
        toneFilter.Q.value = 0.7;
        toneFilter.connect(pre);
        post.connect(output);
        shaper.disconnect();
        shaper.connect(post);

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(Math.max(gainVal, 0.0002), when);
        amp.gain.setTargetAtTime(0.0001, when + 0.01, decay / 3);
        amp.connect(toneFilter);

        const osc = ctx.createOscillator();
        osc.type = "sine";
        const startFreq = freq * (1 + drop * 1.3);
        osc.frequency.setValueAtTime(Math.max(20, startFreq), when);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq), when + 0.06);
        osc.connect(amp);
        osc.start(when);
        osc.stop(stopTime);

        if ((p.click ?? 0.35) > 0.005) {
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const hp = ctx.createBiquadFilter();
          hp.type = "highpass";
          hp.frequency.value = 2500;
          const g = ctx.createGain();
          g.gain.setValueAtTime((p.click ?? 0.35) * 0.7 * velocity, when);
          g.gain.setTargetAtTime(0.0001, when + 0.002, 0.004);
          src.connect(hp).connect(g).connect(post);
          src.start(when);
          src.stop(when + 0.05);
        }

        const voice: Voice = {
          stopAt: stopTime,
          stop: (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            try { osc.stop(t + 0.06); } catch { /* already stopped */ }
          },
          silence: (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
            try { osc.stop(now + 0.05); } catch { /* already stopped */ }
          },
        };
        current = voice;
        osc.onended = () => {
          amp.disconnect();
          toneFilter.disconnect();
          pre.disconnect();
          if (current === voice) current = null;
        };
      },
      setParameter(id, value) {
        p[id] = value;
      },
      panic() {
        current?.silence(ctx.currentTime);
        current = null;
      },
      dispose() {
        this.panic();
        shaper.disconnect();
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- Sampler ---------------- */

const sampler: InstrumentDefinition = {
  kind: "sampler",
  name: "Sampler",
  params: [
    { id: "root", label: "ROOT", min: 24, max: 84, default: 60, format: (v) => `${Math.round(v)}` },
    { id: "attack", label: "ATTACK", min: 0.001, max: 1, default: 0.003, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 2, default: 0.12, unit: "s", format: formatMs },
    { id: "cutoff", label: "CUTOFF", min: 500, max: 16000, default: 15000, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 8, default: 0.7, format: (v) => v.toFixed(2) },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.9, format: formatPct },
  ],
  factory(ctx, track, env) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    let sampleId: string | null = track.sampleId;
    const { voices, register, cleanup } = makeVoiceManager(16);
    const liveFilters = new Set<BiquadFilterNode>();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const buffer = env.getSample(sampleId);
        if (!buffer) return;
        const root = Math.round(p.root ?? 60);
        const attack = Math.max(0.001, p.attack ?? 0.003);
        const release = Math.max(0.01, p.release ?? 0.12);
        const hold = Math.max(durationSec, attack + 0.01);
        const off = when + hold;
        const stopTime = off + release * 3 + 0.05;

        const amp = ctx.createGain();
        const peak = velocity * (p.gain ?? 0.9);
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
        amp.gain.setTargetAtTime(0.0001, off, release / 3);
        amp.connect(output);

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = p.cutoff ?? 15000;
        filter.Q.value = p.resonance ?? 0.7;
        filter.connect(amp);
        liveFilters.add(filter);

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = Math.pow(2, (pitch - root) / 12);
        src.connect(filter);
        src.start(when);
        src.stop(stopTime);

        const voice = register(
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            try { src.stop(t + 0.05); } catch { /* already stopped */ }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
          },
        );
        src.onended = () => {
          liveFilters.delete(filter);
          amp.disconnect();
          filter.disconnect();
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
        if (id === "resonance") for (const f of liveFilters) f.Q.setTargetAtTime(value, ctx.currentTime, 0.02);
      },
      setSample(id) {
        sampleId = id;
      },
      panic() {
        for (const voice of [...voices]) voice.silence(ctx.currentTime);
        voices.length = 0;
        liveFilters.clear();
      },
      dispose() {
        this.panic();
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- registry ---------------- */

export const INSTRUMENT_DEFS: Record<InstrumentKind, InstrumentDefinition> = {
  sampler,
  analog,
  bass,
  "808": bass808,
};

export const INSTRUMENT_ORDER: InstrumentKind[] = ["sampler", "analog", "bass", "808"];

export function defaultInstrumentParams(kind: InstrumentKind): Record<string, number> {
  return Object.fromEntries(INSTRUMENT_DEFS[kind].params.map((p) => [p.id, p.default]));
}

export function clampInstrumentParam(kind: InstrumentKind, paramId: string, value: number): number {
  const def: ParamDef | undefined = INSTRUMENT_DEFS[kind].params.find((p) => p.id === paramId);
  if (!def) return value;
  return Math.min(def.max, Math.max(def.min, value));
}

export function instrumentTrackKindLabel(track: InstrumentTrack): string {
  return INSTRUMENT_DEFS[track.instrument].name;
}
