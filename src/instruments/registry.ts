import type { InstrumentDefinition, InstrumentRuntime } from "./types";
import type { InstrumentKind, InstrumentTrack } from "../project-model/types";
import { midiToFreq } from "../project-model/types";
import type { ParamDef } from "../effects/types";
import { hashString, mulberry32 } from "../shared/rng";
import { extractWavetable, FACTORY_TABLE_OPTIONS, FACTORY_WAVETABLES, FRAME_SIZE } from "./wavetables";

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
  pitch: number;
  stopAt: number;
  stop(when: number): void;
  silence(now: number): void;
}

function makeVoiceManager(limit: number) {
  const voices: Voice[] = [];
  const register = (pitch: number, stopAt: number, stop: (when: number) => void, silence: (now: number) => void): Voice => {
    const voice: Voice = { pitch, stopAt, stop, silence };
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
  const findByPitch = (pitch: number): Voice[] => voices.filter((v) => v.pitch === pitch);
  return { voices, register, cleanup, findByPitch };
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
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(12);

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
          pitch,
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
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") applyFilterLive((f) => f.frequency.setTargetAtTime(value, when, 0.02));
        if (id === "resonance") applyFilterLive((f) => f.Q.setTargetAtTime(value, when, 0.02));
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
      },
      polyPressure(pitch, pressure, when) {
        const cutoffBase = p.cutoff ?? 9000;
        const target = cutoffBase * (1 + pressure * 0.5);
        for (const v of findByPitch(pitch)) {
          void v; void when; void target;
          // Per-voice filter modulation would require tracking filter per voice
          // For now, modulate globally via applyFilterLive
        }
        applyFilterLive((f) => f.frequency.setTargetAtTime(target, when, 0.01));
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
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(4);


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
          pitch,
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
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
        if (id === "resonance") for (const f of liveFilters) f.Q.setTargetAtTime(value, when, 0.02);
        if (id === "grit") applyGrit();
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
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
        // The shared shaper feeds every live voice's post — no rewiring here.
        // (It used to disconnect() the shaper per note, hard-cutting the
        // previous voice's release tail; each voice now removes its own post
        // in onended instead of accumulating connections on `output` forever.)
        shaper.connect(post);
        post.connect(output);

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
          // The click chain is short-lived — tear it down explicitly so it
          // does not linger on `post` after the voice is gone.
          src.onended = () => {
            try { src.disconnect(); } catch { /* already disconnected */ }
            try { hp.disconnect(); } catch { /* already disconnected */ }
            try { g.disconnect(); } catch { /* already disconnected */ }
          };
        }

        const voice: Voice = {
          pitch,
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
          post.disconnect();
          try { shaper.disconnect(post); } catch { /* already disconnected */ }
          if (current === voice) current = null;
        };
      },
      setParameter(id, value) {
        p[id] = value;
      },
      setParameterAt(id, value) {
        p[id] = value;
      },
      noteOff(_pitch, when) {
        current?.stop(when);
        current = null;
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
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(16);
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
          pitch,
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
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
        if (id === "resonance") for (const f of liveFilters) f.Q.setTargetAtTime(value, when, 0.02);
      },
      setSample(id) {
        sampleId = id;
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
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

/* ---------------- Texture Synth ---------------- */
// Polyphonic pad/drone/atmosphere instrument.
// Signal path per voice:
//   OSC1 (sine/saw) + OSC2 (sine/saw, detuned) + filtered noise
//     -> bandpass (color/Q, LFO1-modulated)
//     -> voice amp (tremolo LFO3)
//     -> sum (shared)
//   sum -> output (dry) + delay (space) -> feedback -> output
// Shared LFOs (LFO1, LFO2) modulate filter cutoff and oscillator detune; per-voice
// LFO3 adds a subtle amp tremolo. All audio-rate, no worklets. Polyphony 4, oldest steal.

const texture: InstrumentDefinition = {
  kind: "texture",
  name: "Texture Synth",
  params: [
    { id: "color", label: "COLOR", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "motion", label: "MOTION", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "space", label: "SPACE", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "density", label: "DENSITY", min: 0, max: 1, default: 0.7, format: formatPct },
    { id: "texture", label: "TEXTURE", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "chaos", label: "CHAOS", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -10, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(4);

    // Shared LFO1: filter cutoff modulation
    const lfo1 = ctx.createOscillator();
    lfo1.type = "sine";
    lfo1.frequency.value = 0.13;
    const lfo1Depth = ctx.createGain();
    lfo1Depth.gain.value = 0;
    lfo1.connect(lfo1Depth);
    lfo1.start();

    // Shared LFO2: oscillator detune modulation
    const lfo2 = ctx.createOscillator();
    lfo2.type = "sine";
    lfo2.frequency.value = 0.27;
    const lfo2Depth = ctx.createGain();
    lfo2Depth.gain.value = 0;
    lfo2.connect(lfo2Depth);
    lfo2.start();

    // Shared delay feedback for "space"
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.42;
    const delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0;
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = "lowpass";
    delayTone.frequency.value = 4000;
    delay.connect(delayTone);
    delayTone.connect(delayFeedback);
    delayFeedback.connect(delay);
    delayTone.connect(output);

    // Per-instrument sum gain (all voices -> sum -> dry + delay)
    const sum = ctx.createGain();
    sum.gain.value = 1;
    sum.connect(output);
    sum.connect(delay);

    const chaosSeed = hashString(track.id) >>> 0;

    const applyParams = () => {
      const motion = p.motion ?? 0.4;
      const space = p.space ?? 0.35;
      const chaos = p.chaos ?? 0.2;
      const now = ctx.currentTime;
      lfo1Depth.gain.setTargetAtTime(800 * motion, now, 0.05);
      lfo2Depth.gain.setTargetAtTime(12 * motion, now, 0.05);
      delayFeedback.gain.setTargetAtTime(space * 0.7, now, 0.05);
      // Chaos shifts LFO rates by up to ±3x of base, deterministically from chaosSeed
      const chaos1 = 1 + (((chaosSeed % 1000) / 1000) - 0.5) * 2 * chaos;
      const chaos2 = 1 + (((chaosSeed >>> 8) % 1000) / 1000) * chaos * 0.6;
      lfo1.frequency.setTargetAtTime(0.13 * chaos1, now, 0.1);
      lfo2.frequency.setTargetAtTime(0.27 * chaos2, now, 0.1);
    };
    applyParams();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const freq = midiToFreq(pitch);
        const color = p.color ?? 0.5;
        const density = p.density ?? 0.7;
        const textureVal = p.texture ?? 0.4;
        const motion = p.motion ?? 0.4;
        const level = velocity * dbToLin(p.level ?? -10);
        const filterFreq = 200 * Math.pow(15, color);
        const filterQ = 0.5 + textureVal * 7.5;
        const useSaw = textureVal > 0.5;
        const hold = Math.max(durationSec, 1.5);
        const stopTime = when + hold + 1.2;

        // Voice amp -> sum
        const voiceGain = ctx.createGain();
        voiceGain.gain.setValueAtTime(0.0001, when);
        voiceGain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), when + 0.5);
        voiceGain.gain.setTargetAtTime(Math.max(level * 0.75, 0.0002), when + 0.5, 0.5);
        voiceGain.gain.setTargetAtTime(0.0001, when + hold + 0.05, 0.6);
        voiceGain.connect(sum);

        // Per-voice LFO3 amp tremolo (subtle breathing)
        const lfo3 = ctx.createOscillator();
        lfo3.type = "sine";
        lfo3.frequency.value = 0.31 + (Math.abs(Math.sin((chaosSeed + pitch) * 0.13)) * 0.4);
        const lfo3Depth = ctx.createGain();
        lfo3Depth.gain.value = 0.25 * (0.3 + motion * 0.7);
        lfo3.connect(lfo3Depth).connect(voiceGain.gain);
        lfo3.start(when);
        lfo3.stop(stopTime + 0.1);

        // Bandpass for the noise stream, modulated by shared LFO1
        const bandpass = ctx.createBiquadFilter();
        bandpass.type = "bandpass";
        bandpass.frequency.setValueAtTime(filterFreq, when);
        bandpass.Q.value = filterQ;
        lfo1Depth.connect(bandpass.frequency);
        bandpass.connect(voiceGain);

        // Filtered noise
        const noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer(ctx, (hashString(`${track.id}:${pitch}`) >>> 0) ^ 0xa5a5);
        noise.loop = true;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = Math.max(0, 1 - density);
        noise.connect(noiseGain).connect(bandpass);
        noise.start(when);
        noise.stop(stopTime + 0.1);

        // OSC1 (sine or saw depending on texture)
        const osc1 = ctx.createOscillator();
        osc1.type = useSaw ? "sawtooth" : "sine";
        osc1.frequency.value = freq;
        lfo2Depth.connect(osc1.detune);
        const osc1Gain = ctx.createGain();
        osc1Gain.gain.value = density * 0.6;
        osc1.connect(osc1Gain).connect(voiceGain);
        osc1.start(when);
        osc1.stop(stopTime + 0.1);

        // OSC2 (detuned copy, opposite waveform blending for richness)
        const osc2 = ctx.createOscillator();
        osc2.type = useSaw ? "sawtooth" : "sine";
        osc2.frequency.value = freq;
        osc2.detune.value = 7;
        lfo2Depth.connect(osc2.detune);
        const osc2Gain = ctx.createGain();
        osc2Gain.gain.value = density * 0.5;
        osc2.connect(osc2Gain).connect(voiceGain);
        osc2.start(when);
        osc2.stop(stopTime + 0.1);

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            voiceGain.gain.cancelScheduledValues(t);
            voiceGain.gain.setTargetAtTime(0.0001, t, 0.3);
            for (const osc of [osc1, osc2, lfo3, noise]) {
              try { osc.stop(t + 0.1); } catch { /* already stopped */ }
            }
          },
          (silenceNow) => {
            voiceGain.gain.cancelScheduledValues(silenceNow);
            voiceGain.gain.setTargetAtTime(0.0001, silenceNow, 0.1);
            for (const osc of [osc1, osc2, lfo3, noise]) {
              try { osc.stop(silenceNow + 0.05); } catch { /* already stopped */ }
            }
          },
        );
        const last = noise;
        last.onended = () => {
          try { bandpass.disconnect(); } catch { /* already disconnected */ }
          try { voiceGain.disconnect(); } catch { /* already disconnected */ }
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "motion" || id === "space" || id === "chaos") applyParams();
      },
      setParameterAt(id, value, _when) {
        p[id] = value;
        if (id === "motion" || id === "space" || id === "chaos") applyParams();
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
      },
      panic() {
        for (const voice of [...voices]) voice.silence(ctx.currentTime);
        voices.length = 0;
      },
      dispose() {
        this.panic();
        try { lfo1.stop(); } catch { /* not started */ }
        try { lfo2.stop(); } catch { /* not started */ }
        lfo1.disconnect();
        lfo2.disconnect();
        lfo1Depth.disconnect();
        lfo2Depth.disconnect();
        sum.disconnect();
        delay.disconnect();
        delayFeedback.disconnect();
        delayTone.disconnect();
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- Wavetable Synth ---------------- */
// Morphing wavetable instrument. Each voice plays two looped single-cycle
// frame buffers crossfaded by the MORPH position, doubled as a detuned
// unison pair plus optional sub oscillator. Factory tables are synthesized
// additively; when the track has a sample assigned (sampleId), the table is
// extracted from that sample via autocorrelation period detection. A voice
// captures its frame pair at note start — live MORPH moves only the
// crossfade within that pair. All envelopes are scheduled upfront in
// noteOn, so offline rendering matches live playback.

const wavetable: InstrumentDefinition = {
  kind: "wavetable",
  name: "Wavetable Synth",
  params: [
    { id: "table", label: "TABLE", min: 0, max: FACTORY_WAVETABLES.length - 1, default: 0, options: FACTORY_TABLE_OPTIONS },
    { id: "morph", label: "MORPH", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "detune", label: "DETUNE", min: -50, max: 50, default: 7, unit: "ct", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct` },
    { id: "sub", label: "SUB", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 12000, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 12, default: 1, format: (v) => v.toFixed(2) },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.01, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.25, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
  ],
  factory(ctx, track, env) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    let sampleId: string | null = track.sampleId;
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(8);
    const liveFilters = new Set<BiquadFilterNode>();
    // Crossfade pairs of sounding voices (with their fixed frame indices),
    // so live MORPH updates can retune the blend. Frame buffers themselves
    // are captured per voice — re-targeting frames mid-note isn't possible
    // with looped buffer sources.
    const livePairs = new Set<{ a: GainNode; b: GainNode; ia: number; ib: number; level: number }>();
    let frameBuffers: AudioBuffer[] | null = null;
    let tableDirty = true;

    const resolveTable = () => {
      if (sampleId) {
        const buffer = env.getSample(sampleId);
        if (buffer) {
          const table = extractWavetable(buffer.getChannelData(0), buffer.sampleRate);
          if (table && table.frames.length > 0) return table;
        }
      }
      const count = FACTORY_WAVETABLES.length;
      return FACTORY_WAVETABLES[((Math.round(p.table ?? 0) % count) + count) % count];
    };
    const ensureFrames = (): AudioBuffer[] | null => {
      if (tableDirty || !frameBuffers) {
        const table = resolveTable();
        frameBuffers = table.frames.map((f) => {
          const b = ctx.createBuffer(1, f.length, ctx.sampleRate);
          b.getChannelData(0).set(f);
          return b;
        });
        // A user sample that is assigned but not yet in the bank (async
        // restore after a reload) must not cache the factory fallback
        // forever — keep the table dirty so the next noteOn retries with
        // the real sample as soon as it finishes decoding.
        tableDirty = sampleId != null && !env.getSample(sampleId);
      }
      return frameBuffers;
    };
    ensureFrames();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const frames = ensureFrames();
        if (!frames) return;
        const freq = midiToFreq(pitch);
        const attack = Math.max(0.001, p.attack ?? 0.01);
        const release = Math.max(0.01, p.release ?? 0.25);
        const hold = Math.max(durationSec, attack + 0.01);
        const off = when + hold;
        const stopTime = off + release * 3 + 0.05;

        const amp = ctx.createGain();
        const peak = velocity * dbToLin(p.level ?? -6);
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
        amp.gain.setTargetAtTime(0.0001, off, release / 3);
        amp.connect(output);

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = p.cutoff ?? 12000;
        filter.Q.value = p.resonance ?? 1;
        filter.connect(amp);
        liveFilters.add(filter);

        const sources: Array<AudioBufferSourceNode | OscillatorNode> = [];
        const pairs: { a: GainNode; b: GainNode; ia: number; ib: number; level: number }[] = [];
        const morph = Math.min(1, Math.max(0, p.morph ?? 0.3));
        const pos = frames.length === 1 ? 0 : morph * (frames.length - 1);
        const ia = Math.min(frames.length - 2, Math.floor(pos));
        const ib = Math.min(frames.length - 1, ia + 1);
        const blend = pos - ia;

        const mkTableOsc = (detuneCents: number, level: number) => {
          // Detune is folded into playbackRate (2^cents/1200) rather than
          // AudioBufferSourceNode.detune for broader browser support.
          const rate = (freq * Math.pow(2, detuneCents / 1200) * FRAME_SIZE) / ctx.sampleRate;
          const mkFrameSource = (buffer: AudioBuffer) => {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = true;
            src.playbackRate.value = rate;
            src.start(when);
            src.stop(stopTime);
            sources.push(src);
            return src;
          };
          const gA = ctx.createGain();
          const gB = ctx.createGain();
          gA.gain.value = (1 - blend) * level;
          gB.gain.value = blend * level;
          mkFrameSource(frames[ia]).connect(gA).connect(filter);
          mkFrameSource(frames[ib]).connect(gB).connect(filter);
          const pair = { a: gA, b: gB, ia, ib, level };
          pairs.push(pair);
          livePairs.add(pair);
        };
        mkTableOsc(0, 0.5);
        mkTableOsc(p.detune ?? 7, 0.45);

        if ((p.sub ?? 0.2) > 0.005) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = freq / 2;
          const g = ctx.createGain();
          g.gain.value = (p.sub ?? 0.2) * 0.7;
          osc.connect(g).connect(filter);
          osc.start(when);
          osc.stop(stopTime);
          sources.push(osc);
        }

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            for (const src of sources) {
              try { src.stop(t + 0.05); } catch { /* already stopped */ }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
            for (const src of sources) {
              try { src.stop(now + 0.03); } catch { /* already stopped */ }
            }
          },
        );
        const last = sources[sources.length - 1];
        if (last) last.onended = () => {
          liveFilters.delete(filter);
          for (const pair of pairs) livePairs.delete(pair);
          amp.disconnect();
          filter.disconnect();
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
        const now = ctx.currentTime;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, now, 0.02);
        if (id === "resonance") for (const f of liveFilters) f.Q.setTargetAtTime(value, now, 0.02);
        if (id === "morph") {
          // Voices whose captured frame pair still contains the new morph
          // position retune their crossfade; pairs further away keep theirs.
          const frames = frameBuffers;
          if (frames && frames.length > 1) {
            const pos = Math.min(1, Math.max(0, value)) * (frames.length - 1);
            const ia = Math.min(frames.length - 2, Math.floor(pos));
            const blend = pos - ia;
            for (const pair of livePairs) {
              if (pair.ia !== ia) continue;
              pair.a.gain.setTargetAtTime((1 - blend) * pair.level, now, 0.02);
              pair.b.gain.setTargetAtTime(blend * pair.level, now, 0.02);
            }
          }
        }
        if (id === "table") tableDirty = true;
      },
      setParameterAt(id, value, when) {
        this.setParameter(id, value);
        void when;
      },
      setSample(id) {
        sampleId = id;
        tableDirty = true;
        ensureFrames();
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
      },
      panic() {
        for (const voice of [...voices]) voice.silence(ctx.currentTime);
        voices.length = 0;
        liveFilters.clear();
        livePairs.clear();
      },
      dispose() {
        this.panic();
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- Granular Synth ---------------- */
// Granular sampler. Every note schedules its full grain cloud upfront with
// a deterministic PRNG (seeded from track id + pitch), so offline renders
// are identical to live playback. Each grain is a short AudioBufferSource
// with a trapezoid envelope, random pan within SPREAD, and optional
// reversal through a cached reversed copy of the source buffer.

const MAX_GRAINS_PER_NOTE = 512;

const granular: InstrumentDefinition = {
  kind: "granular",
  name: "Granular Synth",
  params: [
    { id: "position", label: "POSITION", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "size", label: "GRAIN", min: 0.02, max: 0.4, default: 0.09, unit: "s", format: formatMs },
    { id: "rate", label: "RATE", min: 1, max: 60, default: 14, unit: "/s", format: (v) => `${Math.round(v)}/s` },
    { id: "jitter", label: "JITTER", min: 0, max: 1, default: 0.15, format: formatPct },
    { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "pitch", label: "PITCH", min: -24, max: 24, default: 0, format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st` },
    { id: "reverse", label: "REVERSE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "tone", label: "TONE", min: 200, max: 16000, default: 9000, unit: "Hz", format: formatHz },
    { id: "shape", label: "SHAPE", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.02, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 3, default: 0.4, unit: "s", format: formatMs },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.8, format: formatPct },
  ],
  factory(ctx, track, env) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    let sampleId: string | null = track.sampleId;
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(6);

    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = p.tone ?? 9000;
    tone.Q.value = 0.7;
    tone.connect(output);

    const reversedCache = new Map<AudioBuffer, AudioBuffer>();
    const reversedBuffer = (buffer: AudioBuffer): AudioBuffer => {
      let rev = reversedCache.get(buffer);
      if (!rev) {
        rev = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const src = buffer.getChannelData(ch);
          const dst = rev.getChannelData(ch);
          for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
        }
        reversedCache.set(buffer, rev);
      }
      return rev;
    };

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const buffer = env.getSample(sampleId);
        if (!buffer) return;
        const position = Math.min(1, Math.max(0, p.position ?? 0.25));
        const size = Math.min(0.4, Math.max(0.02, p.size ?? 0.09));
        const rate = Math.max(1, p.rate ?? 14);
        const jitter = Math.max(0, p.jitter ?? 0.15);
        const spread = Math.max(0, Math.min(1, p.spread ?? 0.5));
        const reverseProb = Math.min(1, Math.max(0, p.reverse ?? 0));
        const shape = Math.min(1, Math.max(0, p.shape ?? 0.5));
        const attack = Math.max(0.001, p.attack ?? 0.02);
        const release = Math.max(0.01, p.release ?? 0.4);
        const rand = mulberry32(hashString(`${track.id}:${pitch}`));

        const hold = Math.max(durationSec, size + 0.02);
        const off = when + hold;
        const stopTime = off + release * 3 + 0.1;

        const amp = ctx.createGain();
        const peak = velocity * (p.gain ?? 0.8);
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
        amp.gain.setTargetAtTime(0.0001, off, release / 3);
        amp.connect(tone);

        const playRate = Math.pow(2, (pitch - 60 + (p.pitch ?? 0)) / 12);
        // Overlapping grains sum — compensate so RATE×GRAIN presets stay level.
        const overlap = Math.max(0.75, rate * size);
        const grainPeak = (velocity * (p.gain ?? 0.8) * 0.7) / overlap;
        const ramp = Math.max(0.004, (0.12 + 0.38 * shape) * size);
        const plateau = Math.max(0, size - 2 * ramp);
        const grainDur = size + 0.01;

        const sources: AudioBufferSourceNode[] = [];
        const grainNodes: Array<{ g: GainNode; pan: StereoPannerNode }> = [];
        const grainCount = Math.min(MAX_GRAINS_PER_NOTE, Math.max(1, Math.ceil(hold * rate)));
        for (let k = 0; k < grainCount; k++) {
          const t0 = when + k / rate;
          if (t0 >= off + 0.005) break;
          const offsetFrac = Math.min(0.999, Math.max(0, position + (rand() * 2 - 1) * jitter * 0.5));
          const reverse = rand() < reverseProb;
          const grainBuffer = reverse ? reversedBuffer(buffer) : buffer;
          let offset = offsetFrac * buffer.duration;
          if (reverse) offset = buffer.duration - offset - grainDur;
          offset = Math.min(Math.max(0, offset), Math.max(0, grainBuffer.duration - grainDur));

          const src = ctx.createBufferSource();
          src.buffer = grainBuffer;
          src.playbackRate.value = playRate;

          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t0);
          g.gain.linearRampToValueAtTime(grainPeak, t0 + ramp);
          g.gain.linearRampToValueAtTime(grainPeak, t0 + ramp + plateau);
          g.gain.linearRampToValueAtTime(0, t0 + size);

          const pan = ctx.createStereoPanner();
          pan.pan.value = (rand() * 2 - 1) * spread;

          src.connect(g).connect(pan).connect(amp);
          src.start(t0, offset, grainDur);
          src.stop(t0 + grainDur + 0.01);
          sources.push(src);
          grainNodes.push({ g, pan });
        }

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.02);
            for (const src of sources) {
              try { src.stop(t + 0.05); } catch { /* already stopped */ }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.012);
            for (const src of sources) {
              try { src.stop(now + 0.03); } catch { /* already stopped */ }
            }
          },
        );
        let ended = 0;
        for (let i = 0; i < sources.length; i++) {
          sources[i].onended = () => {
            try { grainNodes[i].g.disconnect(); grainNodes[i].pan.disconnect(); } catch { /* already gone */ }
            ended++;
            if (ended >= sources.length) {
              amp.disconnect();
              cleanup(voice);
            }
          };
        }
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "tone") tone.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
      },
      setParameterAt(id, value) {
        this.setParameter(id, value);
      },
      setSample(id) {
        sampleId = id;
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
      },
      panic() {
        for (const voice of [...voices]) voice.silence(ctx.currentTime);
        voices.length = 0;
      },
      dispose() {
        this.panic();
        tone.disconnect();
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
  texture,
  wavetable,
  granular,
};

export const INSTRUMENT_ORDER: InstrumentKind[] = ["sampler", "analog", "bass", "808", "texture", "wavetable", "granular"];

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
