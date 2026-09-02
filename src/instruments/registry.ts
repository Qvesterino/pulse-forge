import type { InstrumentDefinition, InstrumentRuntime } from "./types";
import type { InstrumentKind, InstrumentTrack } from "../project-model/types";
import { midiToFreq } from "../project-model/types";
import type { ParamDef } from "../effects/types";
import { hashString, mulberry32 } from "../shared/rng";
import { extractWavetable, FACTORY_TABLE_OPTIONS, FACTORY_WAVETABLES, FRAME_SIZE } from "./wavetables";
import { isWorkletReady } from "../audio-worklets/loader";
import { pitchShiftPreserveDuration } from "../audio-engine/time-stretch";

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
const formatSec = (v: number) => `${v.toFixed(2)} s`;

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

function tubeCurve(drive: number, n = 1024): Float32Array<ArrayBuffer> {
  // Asymmetric tube: 2nd harmonic bump + soft knee
  const k = 1.5 + drive * 3.5;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const base = Math.tanh(x * k);
    curve[i] = base + 0.12 * Math.sin(Math.PI * x) * drive;
  }
  return curve;
}

function hardClipCurve(drive: number, n = 1024): Float32Array<ArrayBuffer> {
  const k = 2.5 + drive * 5.5;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = x * k;
    curve[i] = Math.max(-1, Math.min(1, y * (1 - 0.18 * Math.abs(y))));
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
  const register = (
    pitch: number,
    stopAt: number,
    stop: (when: number) => void,
    silence: (now: number) => void,
  ): Voice => {
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

// UI filter modes: 0 = LP, 1 = BP, 2 = HP. The SVF worklet orders its mode
// param 0=LP 1=HP 2=BP 3=Notch — map on the way in. The biquad fallback just
// swaps its type, so live mode switches work identically on both paths.
const FILTER_MODE_WORKLET = [0, 2, 1];
const FILTER_MODE_BIQUAD = ["lowpass", "bandpass", "highpass"] as const;

function createVoiceFilter(
  ctx: BaseAudioContext,
  initialCutoff: number,
  initialResonance: number,
  modeIndex = 0,
): {
  input: AudioNode;
  output: AudioNode;
  frequency: AudioParam;
  resonance: AudioParam;
  isWorklet: boolean;
  setMode(modeIndex: number): void;
  disconnect(): void;
} {
  if (isWorkletReady("svFilter", ctx)) {
    const node = new AudioWorkletNode(ctx, "svfilter-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
    });
    const cutoffParam = node.parameters.get("cutoff")!;
    const resParam = node.parameters.get("resonance")!;
    const resNorm = Math.min(1, Math.max(0, (initialResonance - 0.1) / 7.9));
    cutoffParam.value = initialCutoff;
    resParam.value = resNorm;
    node.parameters.get("mode")!.value = FILTER_MODE_WORKLET[modeIndex] ?? 0;
    node.parameters.get("drive")!.value = 0;
    node.parameters.get("mix")!.value = 1;
    const input = ctx.createGain();
    const output = ctx.createGain();
    input.connect(node).connect(output);
    return {
      input,
      output,
      frequency: cutoffParam,
      resonance: resParam,
      isWorklet: true,
      setMode(m) {
        node.parameters.get("mode")!.value = FILTER_MODE_WORKLET[m] ?? 0;
      },
      disconnect() {
        input.disconnect();
        node.disconnect();
        output.disconnect();
      },
    };
  }
  const filter = ctx.createBiquadFilter();
  filter.type = FILTER_MODE_BIQUAD[modeIndex] ?? "lowpass";
  filter.frequency.value = initialCutoff;
  filter.Q.value = initialResonance;
  return {
    input: filter,
    output: filter,
    frequency: filter.frequency,
    resonance: filter.Q,
    isWorklet: false,
    setMode(m) {
      filter.type = FILTER_MODE_BIQUAD[m] ?? "lowpass";
    },
    disconnect() {
      filter.disconnect();
    },
  };
}

function setFilterResonance(
  filter: { resonance: AudioParam; isWorklet: boolean },
  value: number,
  when?: number,
  tc = 0.02,
) {
  if (filter.isWorklet) {
    const norm = Math.min(1, Math.max(0, (value - 0.1) / 7.9));
    if (when !== undefined) filter.resonance.setTargetAtTime(norm, when, tc);
    else filter.resonance.value = norm;
  } else {
    if (when !== undefined) filter.resonance.setTargetAtTime(value, when, tc);
    else filter.resonance.value = value;
  }
}

/* ---------------- Analog Synth ---------------- */

const analog: InstrumentDefinition = {
  kind: "analog",
  name: "Analog Synth",
  params: [
    { id: "oscA", label: "OSC A", min: 0, max: 3, default: 2, options: WAVE_OPTIONS },
    { id: "oscB", label: "OSC B", min: 0, max: 3, default: 2, options: WAVE_OPTIONS },
    {
      id: "oscBDetune",
      label: "DETUNE",
      min: -50,
      max: 50,
      default: 8,
      unit: "ct",
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct`,
    },
    { id: "subLevel", label: "SUB", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "noiseLevel", label: "NOISE", min: 0, max: 0.5, default: 0.04, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 9000, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 12, default: 1, format: (v) => v.toFixed(2) },
    {
      id: "mode",
      label: "FILTER",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "LP" },
        { value: 1, label: "BP" },
        { value: 2, label: "HP" },
      ],
    },
    { id: "keytrack", label: "KEY TRK", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "filterEnv", label: "FLT ENV", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "unison", label: "UNISON", min: 1, max: 8, default: 1, format: (v) => `${Math.round(v)}×` },
    { id: "spread", label: "SPREAD", min: 0, max: 50, default: 0, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
    {
      id: "lfoRate",
      label: "LFO RATE",
      min: 0,
      max: 16,
      default: 0,
      unit: "Hz",
      format: (v) => (v < 0.05 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
    { id: "lfoDepth", label: "LFO DEPTH", min: 0, max: 1, default: 0, format: formatPct },
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

    // filter -> sounding pitch, so live CUTOFF moves respect KEYTRACK per note
    const liveFilters = new Map<ReturnType<typeof createVoiceFilter>, number>();
    // Keytrack: CUTOFF is tuned at C4; higher notes open the filter proportionally
    const effCutoff = (base: number, pitch: number) => {
      const trk = Math.max(0, Math.min(1, p.keytrack ?? 0.3));
      return Math.max(60, Math.min(18000, base * Math.pow(midiToFreq(pitch) / midiToFreq(60), trk)));
    };
    const applyFilterLive = (fn: (f: ReturnType<typeof createVoiceFilter>, pitch: number) => void) => {
      for (const [f, pitch] of liveFilters) fn(f, pitch);
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

        const filterMode = Math.max(0, Math.min(2, Math.round(p.mode ?? 0)));
        const filter = createVoiceFilter(ctx, effCutoff(p.cutoff ?? 9000, pitch), p.resonance ?? 1, filterMode);
        liveFilters.set(filter, pitch);
        const base = effCutoff(p.cutoff ?? 9000, pitch);
        const peakCut = Math.min(18000, base + (p.filterEnv ?? 0.3) * velocity * 6000);
        filter.frequency.setValueAtTime(Math.max(40, base * 0.6), when);
        filter.frequency.linearRampToValueAtTime(peakCut, when + attack);
        filter.frequency.setTargetAtTime(base, when + attack, decay / 3);
        setFilterResonance(filter, p.resonance ?? 1);
        filter.output.connect(amp);

        const oscs: OscillatorNode[] = [];
        const lfoNodes: OscillatorNode[] = [];
        const mkOsc = (waveIndex: number, detune: number, level: number, transpose = 0) => {
          const osc = ctx.createOscillator();
          osc.type = WAVE_NAMES[Math.max(0, Math.min(3, Math.round(waveIndex)))];
          osc.frequency.value = freq * Math.pow(2, transpose / 12);
          osc.detune.value = detune;
          const g = ctx.createGain();
          g.gain.value = level;
          osc.connect(g).connect(filter.input);
          osc.start(when);
          osc.stop(stopTime);
          oscs.push(osc);
        };
        mkOsc(p.oscA ?? 2, 0, 0.5);
        mkOsc(p.oscB ?? 2, p.oscBDetune ?? 8, 0.5 * 0.9);
        mkOsc(0, 0, (p.subLevel ?? 0.25) * 0.8, -12);

        // Per-voice cutoff LFO — audio-rate sweep (analog filter wobble)
        const lfoRate = p.lfoRate ?? 0;
        const lfoDepth = p.lfoDepth ?? 0;
        if (lfoRate > 0.05 && lfoDepth > 0.01) {
          const lfo = ctx.createOscillator();
          lfo.type = "sine";
          lfo.frequency.value = lfoRate;
          const depth = ctx.createGain();
          depth.gain.value = lfoDepth * base * 0.7;
          lfo.connect(depth).connect(filter.frequency);
          lfo.start(when);
          lfo.stop(stopTime);
          lfoNodes.push(lfo);
        }
        // Unison: N detuned copies of OSC A fanned across the stereo field
        const unison = Math.max(1, Math.min(8, Math.round(p.unison ?? 1)));
        if (unison > 1) {
          const spread = p.spread ?? 0;
          const uLevel = 0.5 / Math.sqrt(unison);
          for (let u = 0; u < unison; u++) {
            const t = unison === 1 ? 0 : (u / (unison - 1)) * 2 - 1;
            const detune = t * spread;
            const osc = ctx.createOscillator();
            osc.type = WAVE_NAMES[Math.max(0, Math.min(3, Math.round(p.oscA ?? 2)))];
            osc.frequency.value = freq;
            osc.detune.value = detune;
            const g = ctx.createGain();
            g.gain.value = uLevel;
            const pan = ctx.createStereoPanner();
            pan.pan.value = t * 0.6;
            osc.connect(g).connect(pan).connect(filter.input);
            osc.start(when);
            osc.stop(stopTime);
            oscs.push(osc);
          }
        }
        if ((p.noiseLevel ?? 0) > 0.0005) {
          const src = ctx.createBufferSource();
          src.buffer = noise;
          src.loop = true;
          const g = ctx.createGain();
          g.gain.value = p.noiseLevel ?? 0;
          src.connect(g).connect(filter.input);
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
              try {
                osc.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
            for (const lfo of lfoNodes) {
              try {
                lfo.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
            for (const lfo of lfoNodes) {
              try {
                lfo.stop(now + 0.03);
              } catch {
                /* already stopped */
              }
            }
          },
        );
        const latest = oscs[oscs.length - 1];
        if (latest)
          latest.onended = () => {
            liveFilters.delete(filter);
            amp.disconnect();
            filter.disconnect();
            cleanup(voice);
          };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff")
          applyFilterLive((f, pitch) => f.frequency.setTargetAtTime(effCutoff(value, pitch), ctx.currentTime, 0.02));
        if (id === "resonance") applyFilterLive((f) => setFilterResonance(f, value, ctx.currentTime, 0.02));
        if (id === "mode") applyFilterLive((f) => f.setMode(Math.max(0, Math.min(2, Math.round(value)))));
      },
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") applyFilterLive((f, pitch) => f.frequency.setTargetAtTime(effCutoff(value, pitch), when, 0.02));
        if (id === "resonance") applyFilterLive((f) => setFilterResonance(f, value, when, 0.02));
        if (id === "mode") applyFilterLive((f) => f.setMode(Math.max(0, Math.min(2, Math.round(value)))));
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
      },
      polyPressure(pitch, pressure, when) {
        const cutoffBase = p.cutoff ?? 9000;
        const target = cutoffBase * (1 + pressure * 0.5);
        for (const v of findByPitch(pitch)) {
          void v;
          void when;
          void target;
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
    { id: "glide", label: "GLIDE", min: 0, max: 1, default: 0.34, format: formatPct },
    {
      id: "distType",
      label: "DIST",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "Soft" },
        { value: 1, label: "Tube" },
        { value: 2, label: "Hard" },
      ],
    },
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

    const liveFilters = new Set<ReturnType<typeof createVoiceFilter>>();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec, slideFrom) {
        const freq = midiToFreq(pitch);
        const width = p.width ?? 0.2;
        const hold = Math.max(durationSec, 0.03);
        const off = when + hold;
        const release = 0.1;
        const stopTime = off + release * 2 + 0.1;
        const level = velocity * dbToLin(p.level ?? -6);

        const glideNorm = Math.max(0, Math.min(1, p.glide ?? 0.34));
        const glide = glideNorm * 0.35;
        const slideOn = !!slideFrom;
        const glideStart = slideFrom ? Math.max(0, slideFrom.when) : when;
        // Per-voice shaper so distType does not bleed — grit scales curve amount
        const distType = Math.max(0, Math.min(2, Math.round(p.distType ?? 0)));
        const grit = p.grit ?? 0.25;
        const shaper = ctx.createWaveShaper();
        shaper.oversample = "2x";
        shaper.curve =
          distType === 2 ? hardClipCurve(grit) : distType === 1 ? tubeCurve(grit) : tanhCurve(1 + grit * 8);
        shaper.connect(output);

        const amp = ctx.createGain();
        if (slideOn && glide > 0.002 && slideFrom) {
          amp.gain.setValueAtTime(Math.max(level * 0.9, 0.0002), glideStart);
          amp.gain.setValueAtTime(Math.max(level, 0.0002), when);
          amp.gain.setTargetAtTime(Math.max(level * 0.72, 0.0002), when + 0.003, 0.12);
          amp.gain.setTargetAtTime(0.0001, off, release / 4);
        } else {
          amp.gain.setValueAtTime(0.0001, when);
          amp.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), when + 0.003);
          amp.gain.setTargetAtTime(Math.max(level * 0.72, 0.0002), when + 0.003, 0.12);
          amp.gain.setTargetAtTime(0.0001, off, release / 4);
        }
        amp.connect(shaper);

        const filter = createVoiceFilter(ctx, p.cutoff ?? 700, p.resonance ?? 1.2);
        const base = p.cutoff ?? 700;
        const punch = p.punch ?? 0.5;
        // Sweet-spot: punch now gives tighter 200-2600 range (was 400-4000, too wild)
        const peakCut = Math.min(6500, base + 200 + punch * 2400 * Math.pow(velocity, 0.6));
        filter.frequency.setValueAtTime(Math.max(50, base), when);
        filter.frequency.linearRampToValueAtTime(peakCut, when + 0.005);
        filter.frequency.setTargetAtTime(base, when + 0.005, (0.12 + punch * 0.14) / 1);
        setFilterResonance(filter, p.resonance ?? 1.2);
        filter.output.connect(amp);
        liveFilters.add(filter);

        if ((p.movement ?? 0) > 0.005) {
          const lfo = ctx.createOscillator();
          lfo.type = "sine";
          lfo.frequency.value = 3.2 + (p.movement ?? 0) * 1.8; // 3.2..5.0 Hz sweet spot
          const depth = ctx.createGain();
          // 1200 Hz scaling: 0.15→180 Hz (audible), 0.6→720 Hz (acid wobble), was 105/420
          depth.gain.value = (p.movement ?? 0) * 1200 * (0.7 + punch * 0.35);
          lfo.connect(depth).connect(filter.frequency);
          lfo.start(when);
          lfo.stop(stopTime);
        }

        const oscs: OscillatorNode[] = [];
        const mkVoiceOsc = (
          detuneCents: number,
          levelGain: number,
          panValue: number,
          type: OscillatorType,
          transpose = 0,
        ) => {
          const osc = ctx.createOscillator();
          osc.type = type;
          const targetFreq = freq * Math.pow(2, transpose / 12);
          osc.detune.value = detuneCents;
          const g = ctx.createGain();
          g.gain.value = levelGain;
          const pan = ctx.createStereoPanner();
          pan.pan.value = panValue;
          osc.connect(g).connect(pan).connect(filter.input);
          if (slideOn && slideFrom && glide > 0.002) {
            const fromFreq = midiToFreq(slideFrom.pitch) * Math.pow(2, transpose / 12);
            osc.frequency.setValueAtTime(Math.max(20, fromFreq), glideStart);
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, targetFreq), glideStart + glide);
            osc.start(glideStart);
          } else {
            osc.frequency.value = targetFreq;
            osc.start(when);
          }
          osc.stop(stopTime);
          oscs.push(osc);
        };
        // Role tuning: Bass = body-first + filter punch (vs 808 = sub-first + hard clip)
        // Make body more dominant, sub slightly pulled back → clear separation
        const bodyLevel = 0.28 + (p.body ?? 0.7) * 0.52;
        mkVoiceOsc(0, bodyLevel * 0.72, -width, "sawtooth");
        mkVoiceOsc(width * 25, bodyLevel * 0.72, width, "square");
        mkVoiceOsc(0, (p.sub ?? 0.6) * 0.82, 0, "sine", -12);

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            for (const osc of oscs) {
              try {
                osc.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
          },
        );
        const last = oscs[oscs.length - 1];
        if (last)
          last.onended = () => {
            liveFilters.delete(filter);
            amp.disconnect();
            filter.disconnect();
            try {
              shaper.disconnect();
            } catch {
              /* already */
            }
            cleanup(voice);
          };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, ctx.currentTime, 0.02);
      },
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, when, 0.02);
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

/* ---------------- 808 Synth ---------------- */

const bass808: InstrumentDefinition = {
  kind: "808",
  name: "808 Synth",
  params: [
    { id: "decay", label: "DECAY", min: 0.05, max: 4, default: 0.9, unit: "s", format: (v) => `${v.toFixed(2)} s` },
    { id: "pitchDrop", label: "P-DROP", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "click", label: "CLICK", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "glide", label: "GLIDE", min: 0, max: 1, default: 0.34, format: formatPct },
    {
      id: "distType",
      label: "DIST",
      min: 0,
      max: 2,
      default: 0,
      options: [
        { value: 0, label: "Soft" },
        { value: 1, label: "Tube" },
        { value: 2, label: "Hard" },
      ],
    },
    { id: "sub", label: "SUB", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "tone", label: "TONE", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.85, format: formatPct },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const noise = noiseBuffer(ctx, hashString(track.id) ^ 0x5f5f);
    let current: Voice | null = null;

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, _durationSec, slideFrom) {
        current?.stop(when);
        const freq = midiToFreq(pitch);
        const decay = Math.max(0.05, p.decay ?? 0.9);
        const drop = p.pitchDrop ?? 0.4;
        const toneHz = 150 * Math.pow(2, (p.tone ?? 0.35) * 5.5);
        const gainVal = velocity * (p.gain ?? 0.85);
        const stopTime = when + decay + 0.6;

        const glideNorm = Math.max(0, Math.min(1, p.glide ?? 0.34));
        const glide = glideNorm * 0.35; // 0..1 → 0..0.35 s lineárne
        const distType = Math.max(0, Math.min(2, Math.round(p.distType ?? 0)));
        const drive = p.drive ?? 0.25;
        const subLev = Math.max(0, Math.min(1, p.sub ?? 0.35));
        const slideOn = !!slideFrom;
        const glideStart = slideFrom ? Math.max(0, slideFrom.when) : when;

        // Per-voice shaper so distType does not bleed between voices
        const shaper = ctx.createWaveShaper();
        shaper.oversample = "2x";
        shaper.curve =
          distType === 2 ? hardClipCurve(drive) : distType === 1 ? tubeCurve(drive) : tanhCurve(1.8 + drive * 2);

        const pre = ctx.createGain();
        pre.gain.value = 1 + drive * 4;
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
        if (slideOn && slideFrom) {
          // Portamento: glide time controls ramp length (0 = instant, 0.12 trap, 0.35 slow)
          const fromFreq = midiToFreq(slideFrom.pitch);
          const glideTime = glide > 0.002 ? glide : 0;
          const rampEnd = glideTime > 0 ? glideStart + glideTime : when;
          osc.frequency.setValueAtTime(Math.max(20, fromFreq), glideStart);
          if (glideTime > 0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq), rampEnd);
          else osc.frequency.setValueAtTime(Math.max(20, freq), when);
          osc.start(glideStart);
          // Fade in quickly at glide start (continuous sound — no new attack)
          amp.gain.cancelScheduledValues(glideStart);
          amp.gain.setValueAtTime(Math.max(gainVal * 0.9, 0.0002), glideStart);
          amp.gain.setValueAtTime(Math.max(gainVal, 0.0002), when);
        } else {
          const startFreq = freq * (1 + drop * 1.3);
          osc.frequency.setValueAtTime(Math.max(20, startFreq), when);
          osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq), when + 0.06);
          osc.start(when);
        }
        osc.connect(amp);
        osc.stop(stopTime);

        // Sub octave — clean outside shaper, drive/dist only on main
        let subOsc: OscillatorNode | null = null;
        let subGain: GainNode | null = null;
        if (subLev > 0.005) {
          subOsc = ctx.createOscillator();
          subOsc.type = "sine";
          subGain = ctx.createGain();
          subGain.gain.setValueAtTime(subLev * 0.55 * velocity, when);
          subGain.gain.setTargetAtTime(0.0001, when + 0.01, decay / 3);
          subOsc.connect(subGain).connect(post);
          if (slideOn && slideFrom) {
            const fromFreq = midiToFreq(slideFrom.pitch) / 2;
            const glideTime = glide > 0.002 ? glide : 0;
            subOsc.frequency.setValueAtTime(Math.max(20, fromFreq), glideStart);
            if (glideTime > 0)
              subOsc.frequency.exponentialRampToValueAtTime(Math.max(20, freq / 2), glideStart + glideTime);
            else subOsc.frequency.setValueAtTime(Math.max(20, freq / 2), when);
            subOsc.start(glideStart);
          } else {
            subOsc.frequency.value = freq / 2;
            subOsc.start(when);
          }
          subOsc.stop(stopTime);
        }

        if ((p.click ?? 0.35) > 0.005 && !slideOn) {
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
            try {
              src.disconnect();
            } catch {
              /* already disconnected */
            }
            try {
              hp.disconnect();
            } catch {
              /* already disconnected */
            }
            try {
              g.disconnect();
            } catch {
              /* already disconnected */
            }
          };
        }

        const voice: Voice = {
          pitch,
          stopAt: stopTime,
          stop: (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            if (subGain) {
              subGain.gain.cancelScheduledValues(t);
              subGain.gain.setTargetAtTime(0.0001, t, 0.01);
            }
            try {
              osc.stop(t + 0.06);
            } catch {
              /* already stopped */
            }
            if (subOsc) {
              try {
                subOsc.stop(t + 0.06);
              } catch {
                /* already stopped */
              }
            }
          },
          silence: (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
            if (subGain) {
              subGain.gain.cancelScheduledValues(now);
              subGain.gain.setTargetAtTime(0.0001, now, 0.008);
            }
            try {
              osc.stop(now + 0.05);
            } catch {
              /* already stopped */
            }
            if (subOsc) {
              try {
                subOsc.stop(now + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
        };
        current = voice;
        const cleanup = () => {
          amp.disconnect();
          toneFilter.disconnect();
          pre.disconnect();
          try {
            shaper.disconnect();
          } catch {
            /* already */
          }
          post.disconnect();
          if (subOsc) {
            try {
              subOsc.disconnect();
            } catch {
              /* already */
            }
          }
          if (subGain) {
            try {
              subGain.disconnect();
            } catch {
              /* already */
            }
          }
          if (current === voice) current = null;
        };
        osc.onended = cleanup;
        if (subOsc) subOsc.onended = cleanup;
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
    {
      id: "stretch",
      label: "STRETCH",
      min: 0,
      max: 1,
      default: 0,
      options: [
        { value: 0, label: "Pitch" },
        { value: 1, label: "Stretch" },
      ],
    },
    {
      id: "loop",
      label: "LOOP",
      min: 0,
      max: 1,
      default: 0,
      options: [
        { value: 0, label: "One-shot" },
        { value: 1, label: "Loop" },
      ],
    },
    { id: "loopXfade", label: "L-XFADE", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "reverse", label: "REVERSE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "spread", label: "SPREAD", min: 0, max: 1, default: 0, format: formatPct },
  ],
  factory(ctx, track, env) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    let sampleId: string | null = track.sampleId;
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(16);
    const liveFilters = new Set<ReturnType<typeof createVoiceFilter>>();
    const stretchCache = new Map<string, { semitones: number; data: Float32Array }>();
    const STRETCH_CACHE_LIMIT = 24;
    const cacheStretch = (key: string, semitones: number, data: Float32Array) => {
      if (stretchCache.size >= STRETCH_CACHE_LIMIT) {
        const first = stretchCache.keys().next().value as string | undefined;
        if (first !== undefined) stretchCache.delete(first);
      }
      stretchCache.set(key, { semitones, data });
    };
    // Loop prerender cache: seamless sustain buffers with crossfaded seam.
    // Key = sampleId:xfadeFrac — pure fn of sample data → live == offline.
    const loopCache = new Map<string, AudioBuffer>();
    const LOOP_CACHE_LIMIT = 12;
    const makeLoopBuffer = (buffer: AudioBuffer, xfadeFrac: number): AudioBuffer => {
      const len = buffer.length;
      const sr = buffer.sampleRate;
      // Polish: max 80ms (0.08*sr) and max 18% of buffer — avoids 45% wash on short samples
      const rawXLen = len * Math.min(0.45, Math.max(0.02, xfadeFrac));
      const xLen = Math.max(2, Math.min(Math.floor(rawXLen), Math.floor(len * 0.18), Math.floor(0.08 * sr)));
      // Zero-cross snap for seam — search ± min(512, xLen*0.5) around loopLen for sign change closest to 0
      const ch0 = buffer.getChannelData(0);
      let loopLen = len - xLen;
      const search = Math.min(512, Math.floor(xLen * 0.5));
      let bestIdx = loopLen;
      let bestScore = Infinity;
      for (let d = -search; d <= search; d++) {
        const idx = loopLen + d;
        if (idx < 1 || idx >= len - 1) continue;
        const a = ch0[idx];
        const b = ch0[idx + 1];
        const isCross = a * b <= 0;
        const score = Math.abs(a) + Math.abs(b) + (isCross ? 0 : 0.5);
        if (score < bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
        if (isCross && Math.abs(a) < 0.02) break;
      }
      loopLen = Math.max(xLen, Math.min(len - xLen, bestIdx));
      const out = ctx.createBuffer(buffer.numberOfChannels, len, buffer.sampleRate);
      // Loop body: [0, loopLen); seam crossfades tail into head over xLen with Hann window
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const src = buffer.getChannelData(ch);
        const dst = out.getChannelData(ch);
        for (let i = 0; i < loopLen; i++) dst[i] = src[i];
        for (let i = 0; i < xLen; i++) {
          const t = i / xLen;
          // Hann window crossfade — smoother than equal-power cos/sin, inaudible seam
          const w = 0.5 * (1 - Math.cos(Math.PI * t));
          const tailGain = 1 - w;
          const headGain = w;
          const tailIdx = loopLen + i;
          dst[tailIdx] = src[tailIdx] * tailGain + src[i] * headGain;
        }
      }
      return out;
    };
    const getLoopBuffer = (buffer: AudioBuffer, xfade: number): AudioBuffer => {
      const key = `${sampleId}:${xfade.toFixed(3)}`;
      let entry = loopCache.get(key);
      if (!entry) {
        if (loopCache.size >= LOOP_CACHE_LIMIT) {
          const first = loopCache.keys().next().value as string | undefined;
          if (first !== undefined) loopCache.delete(first);
        }
        entry = makeLoopBuffer(buffer, xfade);
        loopCache.set(key, entry);
      }
      return entry;
    };
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
      noteOn(pitch, velocity, when, durationSec, slideFrom) {
        const buffer = env.getSample(sampleId);
        if (!buffer) return;
        const root = Math.round(p.root ?? 60);
        const attack = Math.max(0.001, p.attack ?? 0.003);
        const release = Math.max(0.01, p.release ?? 0.12);
        const hold = Math.max(durationSec, attack + 0.01);
        const off = when + hold;
        const stopTime = off + release * 3 + 0.05;
        const semitones = pitch - root;
        // Slide: reuse the previous voice's buffer source (it keeps playing)
        // and just glide its playbackRate to the new pitch — sampler portamento.
        if (slideFrom) {
          const prevVoices = findByPitch(slideFrom.pitch);
          const prevVoice = prevVoices[prevVoices.length - 1] as
            (Voice & { glide?: (pitch: number, when: number, glideSec: number) => boolean }) | undefined;
          if (
            prevVoice?.glide &&
            prevVoice.glide(pitch, when, Math.max(0.02, Math.min(0.2, when - Math.max(0, slideFrom.when))))
          ) {
            // Glide handled on the existing voice — skip a new attack
            return;
          }
          // Fallback: no live voice to glide — play the note normally
        }

        const amp = ctx.createGain();
        const peak = velocity * (p.gain ?? 0.9);
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
        amp.gain.setTargetAtTime(0.0001, off, release / 3);
        amp.connect(output);

        const filter = createVoiceFilter(ctx, p.cutoff ?? 15000, p.resonance ?? 0.7);
        filter.output.connect(amp);
        liveFilters.add(filter);

        const src = ctx.createBufferSource();
        // Reverse: cached reversed copy (pitch mode only — stretched data can be reversed too but keep simple)
        let playBuffer = buffer;
        if ((p.reverse ?? 0) > 0.5 && !((p.stretch ?? 0) > 0.5)) playBuffer = reversedBuffer(buffer);
        src.buffer = playBuffer;
        const loopOn = (p.loop ?? 0) > 0.5 && !((p.stretch ?? 0) > 0.5);
        if (loopOn) {
          // Seamless sustain: prerendered crossfaded loop buffer
          src.buffer = getLoopBuffer(playBuffer, p.loopXfade ?? 0.3);
          src.loop = true;
          src.playbackRate.value = Math.pow(2, semitones / 12);
        } else if ((p.stretch ?? 0) > 0.5 && semitones !== 0) {
          // Time-stretch: pitch without changing duration. Cache per (sample, semitones).
          const key = `${sampleId}:${semitones}`;
          let entry = stretchCache.get(key);
          if (!entry) {
            const data = pitchShiftPreserveDuration(buffer.getChannelData(0), buffer.sampleRate, semitones);
            entry = { semitones, data };
            cacheStretch(key, semitones, data);
          }
          const stretched = ctx.createBuffer(1, entry.data.length, buffer.sampleRate);
          stretched.getChannelData(0).set(entry.data);
          src.buffer = stretched;
          src.playbackRate.value = 1;
        } else {
          src.playbackRate.value = Math.pow(2, semitones / 12);
        }
        src.connect(filter.input);
        // Stereo spread: deterministic pan per note (seeded) — wide polyphony
        const spread = Math.max(0, Math.min(1, p.spread ?? 0));
        if (spread > 0.005) {
          const rand = mulberry32(hashString(`${track.id}:${pitch}`));
          const pan = ctx.createStereoPanner();
          pan.pan.value = (rand() * 2 - 1) * spread * 0.8;
          filter.output.disconnect();
          filter.output.connect(pan).connect(amp);
          src.onended = () => {
            try {
              pan.disconnect();
            } catch {
              /* already */
            }
            liveFilters.delete(filter);
            amp.disconnect();
            filter.disconnect();
            cleanup(voice);
          };
        }
        src.start(when);
        src.stop(stopTime);

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            try {
              src.stop(t + 0.05);
            } catch {
              /* already stopped */
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
          },
        );
        // Slide support: glide this voice's rate to a new pitch (stretched
        // buffers are fixed-rate — glide only in pitch mode).
        if (!((p.stretch ?? 0) > 0.5)) {
          (voice as Voice & { glide?: unknown }).glide = (
            targetPitch: number,
            at: number,
            glideSec: number,
          ): boolean => {
            try {
              const targetSemis = targetPitch - root;
              const from = src.playbackRate.value;
              src.playbackRate.setValueAtTime(from, Math.max(0, at - glideSec));
              src.playbackRate.exponentialRampToValueAtTime(Math.max(0.01, Math.pow(2, targetSemis / 12)), at);
              // Voice's registered pitch changes so findByPitch finds the slid voice next time
              voice.pitch = targetPitch;
              return true;
            } catch {
              return false;
            }
          };
        }
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
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, ctx.currentTime, 0.02);
      },
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, when, 0.02);
      },
      setSample(id) {
        if (id !== sampleId) stretchCache.clear();
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
      const chaos1 = 1 + ((chaosSeed % 1000) / 1000 - 0.5) * 2 * chaos;
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
        lfo3.frequency.value = 0.31 + Math.abs(Math.sin((chaosSeed + pitch) * 0.13)) * 0.4;
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
              try {
                osc.stop(t + 0.1);
              } catch {
                /* already stopped */
              }
            }
          },
          (silenceNow) => {
            voiceGain.gain.cancelScheduledValues(silenceNow);
            voiceGain.gain.setTargetAtTime(0.0001, silenceNow, 0.1);
            for (const osc of [osc1, osc2, lfo3, noise]) {
              try {
                osc.stop(silenceNow + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
        );
        const last = noise;
        last.onended = () => {
          try {
            bandpass.disconnect();
          } catch {
            /* already disconnected */
          }
          try {
            voiceGain.disconnect();
          } catch {
            /* already disconnected */
          }
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
        try {
          lfo1.stop();
        } catch {
          /* not started */
        }
        try {
          lfo2.stop();
        } catch {
          /* not started */
        }
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
// crossfade within that pair. M RATE / M DEPTH add a per-note crossfade
// LFO on the captured pair (see the livePairs note in factory): rate and
// depth are static per note by design, so offline rendering matches live
// playback. All envelopes are scheduled upfront in noteOn.

const wavetable: InstrumentDefinition = {
  kind: "wavetable",
  name: "Wavetable Synth",
  params: [
    {
      id: "table",
      label: "TABLE",
      min: 0,
      max: FACTORY_WAVETABLES.length - 1,
      default: 0,
      options: FACTORY_TABLE_OPTIONS,
    },
    { id: "morph", label: "MORPH", min: 0, max: 1, default: 0.3, format: formatPct },
    {
      id: "morphRate",
      label: "M RATE",
      min: 0,
      max: 12,
      default: 0,
      unit: "Hz",
      format: (v) => (v < 0.05 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
    { id: "morphDepth", label: "M DEPTH", min: 0, max: 1, default: 0.5, format: formatPct },
    {
      id: "detune",
      label: "DETUNE",
      min: -50,
      max: 50,
      default: 7,
      unit: "ct",
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct`,
    },
    { id: "sub", label: "SUB", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "unison", label: "UNISON", min: 1, max: 8, default: 1, format: (v) => `${Math.round(v)}×` },
    { id: "spread", label: "SPREAD", min: 0, max: 50, default: 0, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
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
    const liveFilters = new Set<ReturnType<typeof createVoiceFilter>>();
    // Crossfade pairs of sounding voices (with their fixed frame indices),
    // so live MORPH updates can retune the blend. Frame buffers themselves
    // are captured per voice — re-targeting frames mid-note isn't possible
    // with looped buffer sources. M RATE / M DEPTH ride on top of these
    // pairs: a per-note sine LFO pushes +wobble into frame A's gain and
    // −wobble into frame B's gain, so the crossfade breathes around the
    // captured MORPH base while a+b stays constant (no amplitude pumping).
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

        const filter = createVoiceFilter(ctx, p.cutoff ?? 12000, p.resonance ?? 1);
        filter.output.connect(amp);
        liveFilters.add(filter);

        const sources: Array<AudioBufferSourceNode | OscillatorNode> = [];
        const pairs: { a: GainNode; b: GainNode; ia: number; ib: number; level: number }[] = [];
        const morph = Math.min(1, Math.max(0, p.morph ?? 0.3));
        // Single-frame tables (short samples) have no pair to crossfade —
        // lock the position to frame 0 so ia never goes negative.
        const single = frames.length < 2;
        const pos = single ? 0 : morph * (frames.length - 1);
        const ia = single ? 0 : Math.min(frames.length - 2, Math.floor(pos));
        const ib = Math.min(frames.length - 1, ia + 1);
        const blend = single ? 0 : pos - ia;

        // Per-note morph LFO (M RATE / M DEPTH). Captured at note start like
        // the frames; sine phase starts at 0 on `when`, deterministic.
        const morphRate = Math.max(0, p.morphRate ?? 0);
        const morphDepth = Math.min(1, Math.max(0, p.morphDepth ?? 0.5));
        let morphLfo: OscillatorNode | null = null;
        if (morphRate > 0.02 && morphDepth > 0.005 && !single) {
          morphLfo = ctx.createOscillator();
          morphLfo.type = "sine";
          morphLfo.frequency.value = morphRate;
          morphLfo.start(when);
          morphLfo.stop(stopTime);
        }
        // +wobble on frame A's gain, −wobble on frame B's: a+b stays at the
        // pair level, so only the crossfade position moves. Sized to the
        // pair's room (blend × level) so gains never dip negative.
        const morphWobbles: Array<{ dg: GainNode; dgInv: GainNode }> = [];
        const wireMorphWobble = (gA: GainNode, gB: GainNode, level: number) => {
          if (!morphLfo) return;
          const room = Math.min(blend, 1 - blend) * level * 0.9;
          const wobble = morphDepth * room;
          if (wobble <= 0.0015) return;
          const dg = ctx.createGain();
          dg.gain.value = wobble;
          const dgInv = ctx.createGain();
          dgInv.gain.value = -wobble;
          morphLfo.connect(dg);
          morphLfo.connect(dgInv);
          dg.connect(gA.gain);
          dgInv.connect(gB.gain);
          morphWobbles.push({ dg, dgInv });
        };

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
          mkFrameSource(frames[ia]).connect(gA).connect(filter.input);
          mkFrameSource(frames[ib]).connect(gB).connect(filter.input);
          const pair = { a: gA, b: gB, ia, ib, level };
          pairs.push(pair);
          livePairs.add(pair);
          wireMorphWobble(gA, gB, level);
        };
        mkTableOsc(0, 0.5);
        mkTableOsc(p.detune ?? 7, 0.45);
        // Unison: N extra detuned table oscs fanned across the stereo field
        const unison = Math.max(1, Math.min(8, Math.round(p.unison ?? 1)));
        if (unison > 1) {
          const spread = p.spread ?? 0;
          const uLevel = 0.4 / Math.sqrt(unison);
          for (let u = 0; u < unison; u++) {
            const t = unison === 1 ? 0 : (u / (unison - 1)) * 2 - 1;
            // Offset from base detune so spread does not cancel the main pair
            const detune = (p.detune ?? 7) * 0.5 + t * spread;
            const panner = ctx.createStereoPanner();
            panner.pan.value = t * 0.6;
            // Reuse table frames per unison voice (morph blend follows main pair)
            const rate = (freq * Math.pow(2, detune / 1200) * FRAME_SIZE) / ctx.sampleRate;
            const mkUFrameSource = (buffer: AudioBuffer) => {
              const src = ctx.createBufferSource();
              src.buffer = buffer;
              src.loop = true;
              src.playbackRate.value = rate;
              src.start(when);
              src.stop(stopTime);
              sources.push(src);
              return src;
            };
            const gAu = ctx.createGain();
            const gBu = ctx.createGain();
            gAu.gain.value = (1 - blend) * uLevel;
            gBu.gain.value = blend * uLevel;
            mkUFrameSource(frames[ia]).connect(gAu).connect(panner).connect(filter.input);
            mkUFrameSource(frames[ib]).connect(gBu).connect(panner).connect(filter.input);
            const pairU = { a: gAu, b: gBu, ia, ib, level: uLevel };
            pairs.push(pairU);
            livePairs.add(pairU);
            wireMorphWobble(gAu, gBu, uLevel);
          }
        }

        if ((p.sub ?? 0.2) > 0.005) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = freq / 2;
          const g = ctx.createGain();
          g.gain.value = (p.sub ?? 0.2) * 0.7;
          osc.connect(g).connect(filter.input);
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
              try {
                src.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
            if (morphLfo) {
              try {
                morphLfo.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
            for (const src of sources) {
              try {
                src.stop(now + 0.03);
              } catch {
                /* already stopped */
              }
            }
            if (morphLfo) {
              try {
                morphLfo.stop(now + 0.03);
              } catch {
                /* already stopped */
              }
            }
          },
        );
        const last = sources[sources.length - 1];
        if (last)
          last.onended = () => {
            liveFilters.delete(filter);
            for (const pair of pairs) livePairs.delete(pair);
            if (morphLfo) {
              try {
                morphLfo.disconnect();
              } catch {
                /* already disconnected */
              }
            }
            for (const { dg, dgInv } of morphWobbles) {
              try {
                dg.disconnect();
              } catch {
                /* already disconnected */
              }
              try {
                dgInv.disconnect();
              } catch {
                /* already disconnected */
              }
            }
            amp.disconnect();
            filter.disconnect();
            cleanup(voice);
          };
      },
      setParameter(id, value) {
        p[id] = value;
        const now = ctx.currentTime;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, now, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, now, 0.02);
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
    {
      id: "pitch",
      label: "PITCH",
      min: -24,
      max: 24,
      default: 0,
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} st`,
    },
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
              try {
                src.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.012);
            for (const src of sources) {
              try {
                src.stop(now + 0.03);
              } catch {
                /* already stopped */
              }
            }
          },
        );
        let ended = 0;
        for (let i = 0; i < sources.length; i++) {
          sources[i].onended = () => {
            try {
              grainNodes[i].g.disconnect();
              grainNodes[i].pan.disconnect();
            } catch {
              /* already gone */
            }
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
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- Keys (FM/Rhodes) ---------------- */
// 4-op FM electric piano: two parallel FM pairs (1->2 body, 3->4 bell) summed
// through a shared lowpass and amp. Ratios are fixed (1:1 and 3.5:1) for
// Rhodes/Wurli/Bell coverage; tine/bell control modulator index, body
// controls carrier mix, damp shapes release and brightness decay.
// All FM via AudioParam (a-rate), deterministic, no Worklet.

const keys: InstrumentDefinition = {
  kind: "keys",
  name: "Keys",
  params: [
    { id: "tine", label: "TINE", min: 0, max: 1, default: 0.55, format: formatPct },
    { id: "bell", label: "BELL", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "damp", label: "DAMP", min: 0, max: 1, default: 0.45, format: formatPct },
    { id: "tremolo", label: "TREM", min: 0, max: 1, default: 0.15, format: formatPct },
    { id: "ratio", label: "RATIO", min: 1, max: 7, default: 3.5, format: (v) => v.toFixed(2) },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 4500, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 8, default: 1.8, format: (v) => v.toFixed(2) },
    {
      id: "lfoRate",
      label: "LFO RATE",
      min: 0,
      max: 16,
      default: 0,
      unit: "Hz",
      format: (v) => (v < 0.05 ? "OFF" : `${v.toFixed(2)} Hz`),
    },
    { id: "lfoDepth", label: "LFO DEPTH", min: 0, max: 1, default: 0, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.005, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.35, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -8, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(8);
    const liveFilters = new Set<ReturnType<typeof createVoiceFilter>>();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const freq = midiToFreq(pitch);
        const attack = Math.max(0.001, p.attack ?? 0.005);
        const release = Math.max(0.01, p.release ?? 0.35);
        const hold = Math.max(durationSec, attack + 0.02);
        const off = when + hold;
        const stopTime = off + release * 2 + 0.2;
        const level = velocity * dbToLin(p.level ?? -8);
        const tine = p.tine ?? 0.55;
        const bell = p.bell ?? 0.3;
        const body = p.body ?? 0.6;
        const damp = p.damp ?? 0.45;
        const trem = p.tremolo ?? 0.15;
        const width = p.width ?? 0.3;

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), when + attack);
        // Damp shortens the sustain tail for a more muted Rhodes
        const sustain = 0.72 - damp * 0.22;
        const dampRelease = release * (0.55 + damp * 0.7);
        amp.gain.setTargetAtTime(Math.max(level * sustain, 0.0002), when + attack, 0.28);
        amp.gain.setTargetAtTime(0.0001, off, dampRelease / 3);
        amp.connect(output);

        if (trem > 0.005) {
          const lfo = ctx.createOscillator();
          lfo.type = "sine";
          lfo.frequency.value = 4.8;
          const depth = ctx.createGain();
          depth.gain.value = trem * 0.28;
          lfo.connect(depth).connect(amp.gain);
          lfo.start(when);
          lfo.stop(stopTime + 0.1);
        }

        const filter = createVoiceFilter(ctx, Math.max(80, Math.min(16000, p.cutoff ?? 4500)), p.resonance ?? 1.8);
        filter.output.connect(amp);
        liveFilters.add(filter);

        // Tremolo also wobbles filter a touch when damp is low (open)
        if (trem > 0.02 && damp < 0.5) {
          const flfo = ctx.createOscillator();
          flfo.type = "sine";
          flfo.frequency.value = 3.2;
          const fdepth = ctx.createGain();
          fdepth.gain.value = 220 * trem * (1 - damp);
          flfo.connect(fdepth).connect(filter.frequency);
          flfo.start(when);
          flfo.stop(stopTime + 0.1);
        }

        const makePair = (
          modRatio: number,
          carRatio: number,
          modIndex: number,
          carLevel: number,
          pan: number,
          fmDecay: number,
        ) => {
          const car = ctx.createOscillator();
          car.type = "sine";
          car.frequency.value = freq * carRatio;
          const mod = ctx.createOscillator();
          mod.type = "sine";
          mod.frequency.value = freq * modRatio;

          const modEnv = ctx.createGain();
          modEnv.gain.setValueAtTime(0.0001, when);
          modEnv.gain.exponentialRampToValueAtTime(Math.max(modIndex * 0.9, 0.0002), when + attack);
          modEnv.gain.setTargetAtTime(Math.max(modIndex * 0.25, 0.0002), when + attack, fmDecay);

          const carEnv = ctx.createGain();
          carEnv.gain.setValueAtTime(0.0001, when);
          carEnv.gain.exponentialRampToValueAtTime(Math.max(carLevel, 0.0002), when + attack);
          carEnv.gain.setTargetAtTime(Math.max(carLevel * 0.85, 0.0002), when + attack, 0.32);
          carEnv.gain.setTargetAtTime(0.0001, off, dampRelease / 3.5);

          const modGain = ctx.createGain();
          modGain.gain.value = modIndex * 420;
          // FM: mod -> modGain -> car.frequency
          mod
            .connect(modEnv)
            .connect(modGain)
            .connect(car.frequency as unknown as AudioNode);

          const panner = ctx.createStereoPanner();
          panner.pan.value = pan;
          car.connect(carEnv).connect(panner).connect(filter.input);

          mod.start(when);
          mod.stop(stopTime);
          car.start(when);
          car.stop(stopTime);
          return { mod, car, modEnv, carEnv, modGain, panner };
        };

        // Velocity drives FM brightness — soft hits are rounder (Rhodes response)
        const velIndex = 0.45 + velocity * 0.55;
        // LFO sweeps FM brightness audio-rate — real osc on modGain.gain
        // Base gain stays at modIndex*420; LFO adds (modIndex*420*multBase)
        // of sweep around it. Per-note rate offset avoids phase-locking.
        const klfoRate = p.lfoRate ?? 0;
        const klfoDepth = p.lfoDepth ?? 0;
        const lfoMultBase = klfoRate > 0.05 ? klfoDepth * 0.6 : 0;
        const bellRatio = Math.max(1, Math.min(7, p.ratio ?? 3.5));
        const pairA = makePair(
          1,
          1,
          (28 + tine * 720) * velIndex,
          0.42 + body * 0.38,
          -width * 0.6,
          0.22 + damp * 0.35,
        );
        const pairB = makePair(
          bellRatio,
          1,
          (18 + bell * 1100) * velIndex,
          bell * 0.55,
          width * 0.6,
          0.18 + damp * 0.28,
        );

        const lfoNodes: OscillatorNode[] = [];
        if (lfoMultBase > 0.001) {
          for (const pair of [pairA, pairB]) {
            const lfo = ctx.createOscillator();
            lfo.type = "sine";
            lfo.frequency.value = klfoRate * (1 + ((pitch * 0.37) % 0.06) - 0.03);
            const depth = ctx.createGain();
            depth.gain.value = (pair.modGain.gain.value || 1) * lfoMultBase;
            lfo.connect(depth).connect(pair.modGain.gain);
            lfo.start(when);
            lfo.stop(stopTime);
            lfoNodes.push(lfo);
          }
        }

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            for (const lfo of lfoNodes) {
              try {
                lfo.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
            for (const { mod, car } of [pairA, pairB]) {
              try {
                mod.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
              try {
                car.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
            for (const lfo of lfoNodes) {
              try {
                lfo.stop(now + 0.03);
              } catch {
                /* already stopped */
              }
            }
            for (const { mod, car } of [pairA, pairB]) {
              try {
                mod.stop(now + 0.03);
              } catch {
                /* already stopped */
              }
              try {
                car.stop(now + 0.03);
              } catch {
                /* already stopped */
              }
            }
          },
        );
        const last = pairB.car;
        last.onended = () => {
          liveFilters.delete(filter);
          amp.disconnect();
          filter.disconnect();
          for (const { modEnv, carEnv, modGain, panner } of [pairA, pairB]) {
            try {
              modEnv.disconnect();
            } catch {
              /* already */
            }
            try {
              carEnv.disconnect();
            } catch {
              /* already */
            }
            try {
              modGain.disconnect();
            } catch {
              /* already */
            }
            try {
              panner.disconnect();
            } catch {
              /* already */
            }
          }
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, ctx.currentTime, 0.02);
      },
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, when, 0.02);
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

/* ---------------- Pluck (Karplus-Strong) ---------------- */
// Physical-model pluck using a tuned delay with filtered feedback.
// Excitation is a short noise burst; the loop is Delay -> Tone filter
// -> Feedback -> Delay, tapped after the filter into the amp/post-filter.
// Damp controls feedback amount and tone, pick controls excitation brightness.

const pluck: InstrumentDefinition = {
  kind: "pluck",
  name: "Pluck Synth",
  params: [
    { id: "pick", label: "PICK", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "damp", label: "DAMP", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "tone", label: "TONE", min: 300, max: 8000, default: 3500, unit: "Hz", format: formatHz },
    { id: "decay", label: "DECAY", min: 0.1, max: 4, default: 0.9, unit: "s", format: formatSec },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.3, format: formatPct },
    { id: "cutoff", label: "CUTOFF", min: 80, max: 16000, default: 9000, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 8, default: 1.2, format: (v) => v.toFixed(2) },
    { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.002, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 4, default: 0.3, unit: "s", format: formatMs },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -8, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(12);
    const liveFilters = new Set<ReturnType<typeof createVoiceFilter>>();
    const exciteNoise = noiseBuffer(ctx, hashString(track.id) ^ 0x33cc);

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const freq = midiToFreq(pitch);
        const attack = Math.max(0.001, p.attack ?? 0.002);
        const release = Math.max(0.01, p.release ?? 0.3);
        const hold = Math.max(durationSec, attack + 0.02);
        const off = when + hold;
        const decay = Math.max(0.1, p.decay ?? 0.9);
        const stopTime = off + Math.max(release, decay) * 1.2 + 0.3;
        const level = velocity * dbToLin(p.level ?? -8);
        const pick = p.pick ?? 0.5;
        const damp = p.damp ?? 0.4;
        const body = p.body ?? 0.6;
        const width = p.width ?? 0.3;

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), when + attack);
        amp.gain.setTargetAtTime(Math.max(level * 0.82, 0.0002), when + attack, 0.12);
        amp.gain.setTargetAtTime(0.0001, off, release / 3);
        amp.connect(output);

        const postFilter = createVoiceFilter(ctx, p.cutoff ?? 9000, p.resonance ?? 1.2);
        postFilter.output.connect(amp);
        liveFilters.add(postFilter);

        const input = ctx.createGain();
        input.gain.value = 1;
        const delay = ctx.createDelay(1);
        delay.delayTime.value = Math.max(0.001, 1 / freq);
        const toneFilter = ctx.createBiquadFilter();
        toneFilter.type = "lowpass";
        // Tone + damp shape the feedback brightness
        toneFilter.frequency.value = Math.max(300, Math.min(8000, (p.tone ?? 3500) * (1 - damp * 0.25)));
        toneFilter.Q.value = 0.7;
        const feedback = ctx.createGain();
        // Damp shortens decay: 0.96 long, 0.88 short
        // Harder hits ring longer — velocity drives KS feedback
        feedback.gain.value = Math.max(
          0.82,
          Math.min(0.995, 0.97 - damp * 0.09 + (p.decay ?? 0.9) * 0.02 + (velocity - 0.8) * 0.04),
        );
        // Feedback loop: input -> delay -> toneFilter -> feedback -> input
        // Tap after toneFilter into amp/postFilter
        input.connect(delay);
        delay.connect(toneFilter);
        toneFilter.connect(feedback);
        feedback.connect(input);
        toneFilter.connect(postFilter.input);

        // Excitation: short noise burst shaped by pick (brightness) + body (level)
        const src = ctx.createBufferSource();
        src.buffer = exciteNoise;
        // Pick: brighter = highpass, softer = lowpass
        const exciteFilter = ctx.createBiquadFilter();
        exciteFilter.type = pick < 0.5 ? "lowpass" : "highpass";
        exciteFilter.frequency.value = pick < 0.5 ? 800 + pick * 4000 : 1200 + pick * 6000;
        exciteFilter.Q.value = 0.7;
        const exciteGain = ctx.createGain();
        exciteGain.gain.setValueAtTime(0.0001, when);
        exciteGain.gain.exponentialRampToValueAtTime(Math.max(0.3 + body * 0.7, 0.0002) * velocity, when + 0.001);
        exciteGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.008);
        src.connect(exciteFilter).connect(exciteGain).connect(input);
        src.start(when);
        src.stop(when + 0.02);

        const panner = ctx.createStereoPanner();
        // Width via pan spread per voice (deterministic from pitch)
        panner.pan.value = (pitch % 2 === 0 ? 1 : -1) * width * 0.5;
        // Rewire: postFilter already connected to amp, amp to panner? Actually amp is after postFilter, so we need panner after amp
        // Our chain above: toneFilter -> postFilter -> amp, so amp is after postFilter.
        // To add width, we insert panner after amp
        try {
          amp.disconnect();
        } catch {
          /* not connected yet? */
        }
        amp.connect(panner).connect(output);
        // postFilter was connected to amp, keep it: toneFilter -> postFilter -> amp
        // So we need to ensure postFilter -> amp remains, and amp -> panner -> output is separate.
        // The earlier postFilter.connect(amp) is correct, amp now goes to panner.

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            try {
              src.stop(t + 0.02);
            } catch {
              /* already stopped */
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
            try {
              src.stop(now + 0.02);
            } catch {
              /* already stopped */
            }
          },
        );
        // Clock oscillator for deterministic cleanup (works for both live and offline)
        const clock = ctx.createOscillator();
        clock.type = "sine";
        clock.frequency.value = 440;
        const clockGain = ctx.createGain();
        clockGain.gain.value = 0;
        clock.connect(clockGain).connect(ctx.destination);
        clock.start(when);
        clock.stop(stopTime);
        clock.onended = () => {
          liveFilters.delete(postFilter);
          try {
            input.disconnect();
          } catch {
            /* already */
          }
          try {
            delay.disconnect();
          } catch {
            /* already */
          }
          try {
            toneFilter.disconnect();
          } catch {
            /* already */
          }
          try {
            feedback.disconnect();
          } catch {
            /* already */
          }
          try {
            postFilter.disconnect();
          } catch {
            /* already */
          }
          try {
            panner.disconnect();
          } catch {
            /* already */
          }
          amp.disconnect();
          try {
            clock.disconnect();
          } catch {
            /* already */
          }
          try {
            clockGain.disconnect();
          } catch {
            /* already */
          }
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, ctx.currentTime, 0.02);
      },
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, when, 0.02);
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

/* ---------------- Log Drum (Amapiano) ---------------- */
// Tuned perc: 3× sine 1 / 2.15 / 3.8 → notch (hollow) → LP SVF + grit
// pitchDrop on transient, glide + long decay, deterministic

const logdrum: InstrumentDefinition = {
  kind: "logdrum",
  name: "Log Drum",
  params: [
    { id: "decay", label: "DECAY", min: 0.15, max: 3.5, default: 1.1, unit: "s", format: formatSec },
    { id: "pitchDrop", label: "DROP", min: 0, max: 1, default: 0.35, format: formatPct },
    { id: "tone", label: "TONE", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "hollow", label: "HOLLOW", min: 0, max: 1, default: 0.45, format: formatPct },
    { id: "grit", label: "GRIT", min: 0, max: 1, default: 0.12, format: formatPct },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "glide", label: "GLIDE", min: 0, max: 1, default: 0.34, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(4);
    const liveFilters = new Set<ReturnType<typeof createVoiceFilter>>();
    const liveNotches = new Set<BiquadFilterNode>();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec, slideFrom) {
        const freq = midiToFreq(pitch);
        const glideNorm = Math.max(0, Math.min(1, p.glide ?? 0.34));
        const glide = glideNorm * 0.35;
        const slideOn = !!slideFrom;
        const glideStart = slideFrom ? Math.max(0, slideFrom.when) : when;
        const hold = Math.max(durationSec, 0.03);
        const off = when + hold;
        const decay = Math.max(0.15, p.decay ?? 1.1);
        const stopTime = off + decay * 1.2 + 0.15;
        const level = velocity * dbToLin(p.level ?? -6);

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), when + 0.002);
        amp.gain.setTargetAtTime(Math.max(level * 0.55, 0.0002), when + 0.002, decay / 3);
        amp.gain.setTargetAtTime(0.0001, off, decay / 4);
        amp.connect(output);

        const tone = p.tone ?? 0.4;
        const body = p.body ?? 0.6;
        const hollow = p.hollow ?? 0.45;
        const grit = p.grit ?? 0.12;
        const width = p.width ?? 0.25;

        const toneHz = 400 + tone * 2800;
        const filter = createVoiceFilter(ctx, toneHz, 0.9);
        liveFilters.add(filter);
        filter.output.connect(amp);

        const notch = ctx.createBiquadFilter();
        notch.type = "notch";
        notch.frequency.value = 950 + hollow * 300;
        notch.Q.value = 1.1 + hollow * 0.6;
        // depth via gain staging: hollow mixes notch amount (dry/wet by splitting)
        notch.connect(filter.input);
        liveNotches.add(notch);

        const shaper = ctx.createWaveShaper();
        shaper.oversample = "2x";
        shaper.curve = tanhCurve(1 + grit * 5);
        shaper.connect(notch);

        const dropBase = p.pitchDrop ?? 0.35;
        // velocity → pitchDrop: hard hit = more woody knock
        const drop = dropBase * (0.55 + velocity * 0.9);
        // inharmonic drift with pitch: lower notes more woody, higher more harmonic
        const r2 = 2.0 + pitch * 0.004;
        const r3 = 3.8 + (pitch - 60) * 0.006;
        const oscs: OscillatorNode[] = [];
        const mkLogOsc = (ratio: number, gainVal: number, panVal: number) => {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          const target = freq * ratio;
          const start = target * (1 + drop * 1.4);
          const g = ctx.createGain();
          g.gain.value = gainVal;
          const pan = ctx.createStereoPanner();
          pan.pan.value = panVal;
          osc.connect(g).connect(pan).connect(shaper);
          if (slideOn && slideFrom && glide > 0.002) {
            const fromFreq = midiToFreq(slideFrom.pitch) * ratio;
            osc.frequency.setValueAtTime(Math.max(20, fromFreq * (1 + drop * 0.2)), glideStart);
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, target), glideStart + glide);
            g.gain.setValueAtTime(gainVal * 0.9, glideStart);
            g.gain.setValueAtTime(gainVal, when);
            osc.start(glideStart);
          } else {
            osc.frequency.setValueAtTime(Math.max(20, start), when);
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, target), when + 0.045);
            osc.start(when);
          }
          osc.stop(stopTime);
          oscs.push(osc);
        };
        mkLogOsc(1, 0.72, 0);
        mkLogOsc(r2, 0.22 + body * 0.28, -width * 0.6);
        mkLogOsc(r3, 0.08 + body * 0.12, width * 0.6);

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            for (const o of oscs) {
              try {
                o.stop(t + 0.05);
              } catch {
                /* already */
              }
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
          },
        );
        const last = oscs[oscs.length - 1];
        if (last)
          last.onended = () => {
            liveFilters.delete(filter);
            liveNotches.delete(notch);
            amp.disconnect();
            filter.disconnect();
            try {
              notch.disconnect();
            } catch {
              /* already */
            }
            try {
              shaper.disconnect();
            } catch {
              /* already */
            }
            cleanup(voice);
          };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "tone")
          for (const f of liveFilters) f.frequency.setTargetAtTime(400 + value * 2800, ctx.currentTime, 0.02);
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
      },
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "tone") for (const f of liveFilters) f.frequency.setTargetAtTime(400 + value * 2800, when, 0.02);
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
      },
      noteOff(pitch, when) {
        for (const v of findByPitch(pitch)) v.stop(when);
      },
      panic() {
        for (const voice of [...voices]) voice.silence(ctx.currentTime);
        voices.length = 0;
        liveFilters.clear();
        liveNotches.clear();
      },
      dispose() {
        this.panic();
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- Spectral Pad (additive) ---------------- */
// Additive pad: up to 8 sine partials per voice. Each partial gets its own
// amplitude from the PROFILE curve, its own release time from SKEW (high
// partials die first), inharmonic stretching (INHARM, classic stiff-string
// sqrt(1+B*k^2) map) and a deterministic shimmer detune (SHIMMER). Levels
// are RMS-normalized so PROFILE/PARTIALS changes don't jump in loudness.
// All envelopes are scheduled upfront — offline render == live playback.

const SPECTRAL_PROFILE_OPTIONS = [
  { value: 0, label: "Harmonic" },
  { value: 1, label: "Bright" },
  { value: 2, label: "Odd" },
  { value: 3, label: "Formant" },
  { value: 4, label: "Bell" },
];

const SPECTRAL_BELL_CURVE = [1, 0.55, 0.4, 0.5, 0.25, 0.3, 0.15, 0.2];

function spectralPartialGain(profile: number, k: number): number {
  switch (profile) {
    case 1:
      return 1 / Math.sqrt(k);
    case 2:
      return (k % 2 === 1 ? 1 : 0.08) / k;
    case 3:
      return (1 / k) * (1 + 2.2 * Math.exp(-((k - 3) * (k - 3)) / 2));
    case 4:
      return SPECTRAL_BELL_CURVE[k - 1] ?? 0.1;
    default:
      return 1 / k;
  }
}

const spectral: InstrumentDefinition = {
  kind: "spectral",
  name: "Spectral Pad",
  params: [
    { id: "profile", label: "PROFILE", min: 0, max: 4, default: 0, options: SPECTRAL_PROFILE_OPTIONS },
    { id: "partials", label: "PARTIALS", min: 2, max: 8, default: 6, format: (v) => `${Math.round(v)}` },
    { id: "inharm", label: "INHARM", min: 0, max: 1, default: 0.12, format: formatPct },
    { id: "shimmer", label: "SHIMMER", min: 0, max: 1, default: 0.25, format: formatPct },
    { id: "skew", label: "SKEW", min: 0, max: 1, default: 0.45, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 4, default: 0.6, unit: "s", format: formatSec },
    { id: "release", label: "TAIL", min: 0.05, max: 8, default: 3, unit: "s", format: formatSec },
    { id: "cutoff", label: "CUTOFF", min: 200, max: 16000, default: 6000, unit: "Hz", format: formatHz },
    { id: "resonance", label: "RESO", min: 0.1, max: 12, default: 0.8, format: (v) => v.toFixed(2) },
    { id: "width", label: "WIDTH", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -12, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(6);
    const liveFilters = new Set<ReturnType<typeof createVoiceFilter>>();

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, durationSec) {
        const f0 = midiToFreq(pitch);
        const profile = Math.max(0, Math.min(4, Math.round(p.profile ?? 0)));
        const count = Math.max(2, Math.min(8, Math.round(p.partials ?? 6)));
        const inharm = Math.max(0, Math.min(1, p.inharm ?? 0.12));
        const shimmer = Math.max(0, Math.min(1, p.shimmer ?? 0.25));
        const skew = Math.max(0, Math.min(1, p.skew ?? 0.45));
        const width = Math.max(0, Math.min(1, p.width ?? 0.5));
        const attack = Math.max(0.002, p.attack ?? 0.6);
        const release = Math.max(0.05, p.release ?? 3);
        const hold = Math.max(durationSec, attack + 0.05);
        const off = when + hold;
        const stopTime = off + release * 1.5 + 0.3;
        const level = velocity * dbToLin(p.level ?? -12);

        // RMS-normalized partial amplitudes keep level consistent across profiles
        let energy = 0;
        const amps: number[] = [];
        for (let k = 1; k <= count; k++) {
          const a = spectralPartialGain(profile, k);
          amps.push(a);
          energy += a * a;
        }
        const norm = 0.5 / Math.max(0.15, Math.sqrt(energy));

        const filter = createVoiceFilter(ctx, p.cutoff ?? 6000, p.resonance ?? 0.8);
        filter.output.connect(output);
        liveFilters.add(filter);

        const oscs: OscillatorNode[] = [];
        const gains: GainNode[] = [];
        for (let k = 1; k <= count; k++) {
          const a = amps[k - 1];
          if (a * norm < 0.004) continue;
          // Stiff-string inharmonicity: partial k sits sharper than k*f0
          const ratio = k * Math.sqrt(1 + inharm * 0.006 * k * k);
          // Golden-angle shimmer: deterministic per-partial detune spread
          const detune = shimmer * 8 * Math.sin(k * 2.399963);
          const decayTc = Math.max(0.12, release * (1 - skew * ((k - 1) / Math.max(1, count - 1)) * 0.8));
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = f0 * ratio;
          osc.detune.value = detune;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, when);
          g.gain.exponentialRampToValueAtTime(Math.max(a * norm * level, 0.0002), when + attack);
          g.gain.setTargetAtTime(0.0001, off, decayTc / 3);
          const pan = ctx.createStereoPanner();
          pan.pan.value = count === 1 ? 0 : ((k - 1) / (count - 1) * 2 - 1) * width * 0.8;
          osc.connect(g).connect(pan).connect(filter.input);
          osc.start(when);
          osc.stop(stopTime);
          oscs.push(osc);
          gains.push(g);
        }

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            for (const g of gains) {
              g.gain.cancelScheduledValues(t);
              g.gain.setTargetAtTime(0.0001, t, 0.05);
            }
            for (const osc of oscs) {
              try {
                osc.stop(t + 0.2);
              } catch {
                /* already stopped */
              }
            }
          },
          (now) => {
            for (const g of gains) {
              g.gain.cancelScheduledValues(now);
              g.gain.setTargetAtTime(0.0001, now, 0.02);
            }
            for (const osc of oscs) {
              try {
                osc.stop(now + 0.1);
              } catch {
                /* already stopped */
              }
            }
          },
        );
        const last = oscs[oscs.length - 1];
        if (last)
          last.onended = () => {
            liveFilters.delete(filter);
            filter.disconnect();
            cleanup(voice);
          };
      },
      setParameter(id, value) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, ctx.currentTime, 0.02);
      },
      setParameterAt(id, value, when) {
        p[id] = value;
        if (id === "cutoff") for (const f of liveFilters) f.frequency.setTargetAtTime(value, when, 0.02);
        if (id === "resonance") for (const f of liveFilters) setFilterResonance(f, value, when, 0.02);
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

/* ---------------- Vocal Chop (formant sampler) ---------------- */
// Sampler tuned for vocal chops and talkbox-style leads: the sample plays
// through a parallel three-band formant bank (F1/F2/F3 of the selected
// vowel, scaled by SHIFT for voice size). COLOR blends dry sample against
// the formant-filtered copy; MORPH auto-cycles the vowel formants during
// the note for "talking" chops. Vowel targets follow Peterson–Barney-ish
// F1/F2/F3 averages, rounded and deterministic.

const VOWEL_OPTIONS = [
  { value: 0, label: "A" },
  { value: 1, label: "E" },
  { value: 2, label: "I" },
  { value: 3, label: "O" },
  { value: 4, label: "U" },
];

// [F1, F2, F3] in Hz for A/E/I/O/U
const VOWEL_FORMANTS: number[][] = [
  [800, 1150, 2900],
  [400, 1600, 2700],
  [250, 1750, 2900],
  [400, 800, 2600],
  [350, 700, 2400],
];
const VOWEL_BAND_GAINS = [1, 0.6, 0.38];

const vocalchop: InstrumentDefinition = {
  kind: "vocalchop",
  name: "Vocal Chop",
  params: [
    { id: "root", label: "ROOT", min: 24, max: 84, default: 60, format: (v) => `${Math.round(v)}` },
    { id: "vowel", label: "VOWEL", min: 0, max: 4, default: 0, options: VOWEL_OPTIONS },
    { id: "color", label: "COLOR", min: 0, max: 1, default: 0.85, format: formatPct },
    {
      id: "shift",
      label: "SHIFT",
      min: 0.7,
      max: 1.5,
      default: 1,
      format: (v) => `${v.toFixed(2)}×`,
    },
    { id: "sharp", label: "SHARP", min: 0, max: 1, default: 0.5, format: formatPct },
    { id: "morph", label: "MORPH", min: 0, max: 1, default: 0, format: formatPct },
    { id: "tone", label: "TONE", min: 500, max: 16000, default: 12000, unit: "Hz", format: formatHz },
    { id: "reverse", label: "REVERSE", min: 0, max: 1, default: 0, format: formatPct },
    { id: "attack", label: "ATTACK", min: 0.001, max: 1, default: 0.005, unit: "s", format: formatMs },
    { id: "release", label: "RELEASE", min: 0.01, max: 2, default: 0.15, unit: "s", format: formatMs },
    { id: "gain", label: "GAIN", min: 0, max: 1, default: 0.85, format: formatPct },
  ],
  factory(ctx, track, env) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    let sampleId: string | null = track.sampleId;
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(8);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = p.tone ?? 12000;
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
        const root = Math.round(p.root ?? 60);
        const color = Math.max(0, Math.min(1, p.color ?? 0.85));
        const shift = Math.max(0.7, Math.min(1.5, p.shift ?? 1));
        const sharp = Math.max(0, Math.min(1, p.sharp ?? 0.5));
        const q = 4 + sharp * 9;
        const startVowel = Math.max(0, Math.min(4, Math.round(p.vowel ?? 0)));
        const morph = Math.max(0, Math.min(1, p.morph ?? 0));
        const attack = Math.max(0.001, p.attack ?? 0.005);
        const release = Math.max(0.01, p.release ?? 0.15);
        const hold = Math.max(durationSec, attack + 0.02);
        const off = when + hold;
        const stopTime = off + release * 3 + 0.05;
        const peak = velocity * (p.gain ?? 0.85);

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
        amp.gain.setTargetAtTime(0.0001, off, release / 3);
        amp.connect(tone);

        const src = ctx.createBufferSource();
        const playBuffer = (p.reverse ?? 0) > 0.5 ? reversedBuffer(buffer) : buffer;
        src.buffer = playBuffer;
        src.playbackRate.value = Math.pow(2, (pitch - root) / 12);

        // Parallel formant bank + dry blend. Wet is pulled back so full COLOR
        // stays in the same loudness ballpark as the dry sample.
        const dry = ctx.createGain();
        dry.gain.value = 1 - color * 0.85;
        src.connect(dry).connect(amp);
        const wet = ctx.createGain();
        wet.gain.value = color * 0.8;
        const formants: BiquadFilterNode[] = [];
        for (let b = 0; b < 3; b++) {
          const band = ctx.createBiquadFilter();
          band.type = "bandpass";
          band.frequency.value = VOWEL_FORMANTS[startVowel][b] * shift;
          band.Q.value = q;
          const bandGain = ctx.createGain();
          bandGain.gain.value = VOWEL_BAND_GAINS[b];
          src.connect(band).connect(bandGain).connect(wet);
          formants.push(band);
        }
        wet.connect(amp);

        // MORPH walks the formants through the vowel table during the note
        if (morph > 0.02) {
          const period = 0.45 + (1 - morph) * 3.2;
          const steps = Math.min(24, Math.ceil(hold / period));
          for (let s = 1; s <= steps; s++) {
            const t = when + s * period;
            if (t >= off) break;
            const target = VOWEL_FORMANTS[(startVowel + s) % 5];
            for (let b = 0; b < 3; b++) formants[b].frequency.setTargetAtTime(target[b] * shift, t, 0.04);
          }
        }

        src.start(when);
        src.stop(stopTime);

        const voice = register(
          pitch,
          stopTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            amp.gain.cancelScheduledValues(t);
            amp.gain.setTargetAtTime(0.0001, t, 0.01);
            try {
              src.stop(t + 0.05);
            } catch {
              /* already stopped */
            }
          },
          (now) => {
            amp.gain.cancelScheduledValues(now);
            amp.gain.setTargetAtTime(0.0001, now, 0.008);
          },
        );
        src.onended = () => {
          amp.disconnect();
          dry.disconnect();
          wet.disconnect();
          for (const band of formants) {
            try {
              band.disconnect();
            } catch {
              /* already disconnected */
            }
          }
          cleanup(voice);
        };
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
        output.disconnect();
      },
    };
    return runtime;
  },
};

/* ---------------- Drum Synth (analog-modeled, chromatic) ---------------- */
// Drum-machine voices on an instrument track — playable chromatically from
// the piano roll. TYPE selects the analog model (kick/snare/hats/clap/
// perc/cowbell); TONE/SNAP/BODY are normalized macros re-interpreted per
// model (documented inline), so one knob row drives all seven voices.
// Notes transpose every model (2^(pitch/12)), DECAY scales ring time and
// DRIVE runs a shared tanh shaper after the voice. One-shot: gates are
// ignored, voices ring out and clean up after themselves.

const DRUM_TYPE_OPTIONS = [
  { value: 0, label: "Kick" },
  { value: 1, label: "Snare" },
  { value: 2, label: "Hat C" },
  { value: 3, label: "Hat O" },
  { value: 4, label: "Clap" },
  { value: 5, label: "Perc" },
  { value: 6, label: "Cowbell" },
];

const HAT_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

const drumsynth: InstrumentDefinition = {
  kind: "drumsynth",
  name: "Drum Synth",
  params: [
    { id: "type", label: "TYPE", min: 0, max: 6, default: 0, options: DRUM_TYPE_OPTIONS },
    { id: "tune", label: "TUNE", min: -12, max: 12, default: 0, unit: "st", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} st` },
    { id: "tone", label: "TONE", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "decay", label: "DECAY", min: 0.05, max: 2, default: 0.4, unit: "s", format: formatSec },
    { id: "snap", label: "SNAP", min: 0, max: 1, default: 0.4, format: formatPct },
    { id: "body", label: "BODY", min: 0, max: 1, default: 0.6, format: formatPct },
    { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.2, format: formatPct },
    { id: "level", label: "LEVEL", min: -24, max: 6, default: -6, unit: "dB", format: formatDb },
  ],
  factory(ctx, track) {
    const output = ctx.createGain();
    output.gain.value = 1;
    const p = { ...track.params };
    const { voices, register, cleanup, findByPitch } = makeVoiceManager(8);
    const noise = noiseBuffer(ctx, hashString(track.id) ^ 0xd42d);

    const runtime: InstrumentRuntime = {
      output,
      noteOn(pitch, velocity, when, _durationSec, _slideFrom) {
        const type = Math.max(0, Math.min(6, Math.round(p.type ?? 0)));
        const tune = Math.max(-12, Math.min(12, p.tune ?? 0));
        // All models transpose from C4 — po = pitch offset in semitones
        const po = Math.pow(2, (pitch - 60 + tune) / 12);
        const tone = Math.max(0, Math.min(1, p.tone ?? 0.4));
        const decay = Math.max(0.05, p.decay ?? 0.4);
        const snap = Math.max(0, Math.min(1, p.snap ?? 0.4));
        const body = Math.max(0, Math.min(1, p.body ?? 0.6));
        const drive = Math.max(0, Math.min(1, p.drive ?? 0.2));
        const level = velocity * dbToLin(p.level ?? -6);
        const stopTime = when + decay * 2 + 0.4;

        // Shared voice chain: voice nodes -> noteGain -> [shaper] -> level -> output
        const noteGain = ctx.createGain();
        noteGain.gain.value = 1;
        const levelGain = ctx.createGain();
        levelGain.gain.value = level;
        let tail: AudioNode = noteGain;
        if (drive > 0.005) {
          const shaper = ctx.createWaveShaper();
          shaper.oversample = "2x";
          shaper.curve = tanhCurve(1 + drive * 6);
          noteGain.connect(shaper);
          tail = shaper;
        }
        tail.connect(levelGain).connect(output);

        const oscs: OscillatorNode[] = [];
        const srcs: AudioBufferSourceNode[] = [];
        let ringTime = decay;

        if (type === 0) {
          // Kick: TONE sets initial pitch, BODY the drop time and weight
          const fEnd = Math.max(22, Math.min(180, 45 * po));
          const fStart = fEnd * (1.6 + tone * 4.2) + 20;
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.setValueAtTime(fStart, when);
          osc.frequency.exponentialRampToValueAtTime(fEnd, when + 0.03 + body * 0.05);
          const g = ctx.createGain();
          g.gain.setValueAtTime(1, when);
          g.gain.setTargetAtTime(0.0001, when + 0.005, decay / 4);
          osc.connect(g).connect(noteGain);
          osc.start(when);
          osc.stop(stopTime);
          oscs.push(osc);
          ringTime = decay + 0.1;
          if (snap > 0.01) {
            const click = ctx.createBufferSource();
            click.buffer = noise;
            const hp = ctx.createBiquadFilter();
            hp.type = "highpass";
            hp.frequency.value = 3500;
            const cg = ctx.createGain();
            cg.gain.setValueAtTime(snap * 0.6, when);
            cg.gain.setTargetAtTime(0.0001, when + 0.002, 0.003);
            click.connect(hp).connect(cg).connect(noteGain);
            click.start(when);
            click.stop(when + 0.05);
            srcs.push(click);
          }
        } else if (type === 1) {
          // Snare: two detuned tone oscs + noise through a tuned bandpass;
          // TONE centers the wire band, SNAP leans tone->noise balance
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = (900 + tone * 2600) * po;
          bp.Q.value = 0.8;
          const ng = ctx.createGain();
          ng.gain.setValueAtTime(0.35 + snap * 0.55, when);
          ng.gain.setTargetAtTime(0.0001, when + 0.004, decay * 0.25);
          bp.connect(ng).connect(noteGain);
          const nsrc = ctx.createBufferSource();
          nsrc.buffer = noise;
          nsrc.loop = true;
          nsrc.start(when);
          nsrc.stop(stopTime);
          srcs.push(nsrc);
          for (const f of [185, 330]) {
            const osc = ctx.createOscillator();
            osc.type = "triangle";
            osc.frequency.value = f * po;
            const og = ctx.createGain();
            og.gain.setValueAtTime(0.3 + body * 0.3, when);
            og.gain.setTargetAtTime(0.0001, when + 0.003, 0.04 + body * 0.05);
            osc.connect(og).connect(noteGain);
            osc.start(when);
            osc.stop(stopTime);
            oscs.push(osc);
          }
          ringTime = decay * 0.9 + 0.05;
        } else if (type === 2 || type === 3) {
          // Hats: six square oscillators at the classic 808 metallic ratios,
          // bandpass + steep highpass extract the sizzle. Open = longer ring.
          const open = type === 3;
          const base = 130 * po;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = 3200 + tone * 5200;
          bp.Q.value = 1;
          const hp = ctx.createBiquadFilter();
          hp.type = "highpass";
          hp.frequency.value = 6000 * (0.7 + snap * 0.6);
          const hg = ctx.createGain();
          const ring = Math.max(0.05, decay * (open ? 1.6 : 0.5));
          hg.gain.setValueAtTime(0.5, when);
          hg.gain.setTargetAtTime(0.0001, when + 0.002, ring / 3.5);
          bp.connect(hp).connect(hg).connect(noteGain);
          for (const ratio of HAT_RATIOS) {
            const osc = ctx.createOscillator();
            osc.type = "square";
            osc.frequency.value = base * ratio;
            const og = ctx.createGain();
            og.gain.value = 0.12;
            osc.connect(og).connect(bp);
            osc.start(when);
            osc.stop(stopTime);
            oscs.push(osc);
          }
          ringTime = ring + 0.05;
        } else if (type === 4) {
          // Clap: noise bandpass with three fast pre-bursts then the body tail
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = (900 + tone * 1500) * po;
          bp.Q.value = 1.2 + snap * 2.2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.9, when);
          g.gain.exponentialRampToValueAtTime(0.0001, when + 0.009);
          g.gain.setValueAtTime(0.8, when + 0.011);
          g.gain.exponentialRampToValueAtTime(0.0001, when + 0.02);
          g.gain.setValueAtTime(0.75, when + 0.023);
          g.gain.exponentialRampToValueAtTime(0.0001, when + 0.033);
          g.gain.setTargetAtTime(0.0001, when + 0.033, (decay * (0.6 + body * 0.8)) / 3);
          bp.connect(g).connect(noteGain);
          const src = ctx.createBufferSource();
          src.buffer = noise;
          src.loop = true;
          src.start(when);
          src.stop(stopTime);
          srcs.push(src);
          ringTime = decay * (0.6 + body * 0.8) + 0.15;
        } else if (type === 5) {
          // Perc: pitched sine with a SNAP-scaled pitch drop — tunable bongo
          const f = (300 + tone * 1300) * po;
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.setValueAtTime(f * (1 + snap * 1.2), when);
          osc.frequency.exponentialRampToValueAtTime(f, when + 0.02);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.9, when);
          g.gain.setTargetAtTime(0.0001, when + 0.004, (decay * (0.4 + body * 0.4)) / 3);
          osc.connect(g).connect(noteGain);
          osc.start(when);
          osc.stop(stopTime);
          oscs.push(osc);
          ringTime = decay * 0.5 + 0.05;
        } else {
          // Cowbell: two squares at the classic 1 : 1.485 ratio through a bandpass
          const base = (420 + tone * 380) * po;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.value = base * 1.3;
          bp.Q.value = 1 + snap * 2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.7, when);
          g.gain.setTargetAtTime(0.0001, when + 0.004, (decay * (0.5 + body * 0.5)) / 3);
          bp.connect(g).connect(noteGain);
          for (const mult of [1, 1.485]) {
            const osc = ctx.createOscillator();
            osc.type = "square";
            osc.frequency.value = base * mult;
            const og = ctx.createGain();
            og.gain.value = 0.35;
            osc.connect(og).connect(bp);
            osc.start(when);
            osc.stop(stopTime);
            oscs.push(osc);
          }
          ringTime = decay * 0.6 + 0.1;
        }

        const voice = register(
          pitch,
          when + ringTime,
          (whenStop) => {
            const t = Math.max(whenStop, 0);
            noteGain.gain.cancelScheduledValues(t);
            noteGain.gain.setTargetAtTime(0.0001, t, 0.008);
            for (const osc of oscs) {
              try {
                osc.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
            for (const src of srcs) {
              try {
                src.stop(t + 0.05);
              } catch {
                /* already stopped */
              }
            }
          },
          (now) => {
            noteGain.gain.cancelScheduledValues(now);
            noteGain.gain.setTargetAtTime(0.0001, now, 0.006);
            for (const osc of oscs) {
              try {
                osc.stop(now + 0.04);
              } catch {
                /* already stopped */
              }
            }
            for (const src of srcs) {
              try {
                src.stop(now + 0.04);
              } catch {
                /* already stopped */
              }
            }
          },
        );
        // Drums are one-shot: silence the voice once the ring time elapses so
        // the voice manager does not hold dead notes against polyphony.
        const clock = ctx.createOscillator();
        clock.type = "sine";
        clock.frequency.value = 440;
        const clockGain = ctx.createGain();
        clockGain.gain.value = 0;
        clock.connect(clockGain).connect(ctx.destination);
        clock.start(when);
        clock.stop(when + ringTime + 0.05);
        clock.onended = () => {
          try {
            noteGain.disconnect();
          } catch {
            /* already */
          }
          try {
            levelGain.disconnect();
          } catch {
            /* already */
          }
          if (tail !== noteGain) {
            try {
              tail.disconnect();
            } catch {
              /* already */
            }
          }
          try {
            clock.disconnect();
          } catch {
            /* already */
          }
          try {
            clockGain.disconnect();
          } catch {
            /* already */
          }
          cleanup(voice);
        };
      },
      setParameter(id, value) {
        p[id] = value;
      },
      setParameterAt(id, value) {
        p[id] = value;
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
  keys,
  pluck,
  logdrum,
  spectral,
  vocalchop,
  drumsynth,
};

export const INSTRUMENT_ORDER: InstrumentKind[] = [
  "sampler",
  "analog",
  "bass",
  "808",
  "texture",
  "wavetable",
  "granular",
  "keys",
  "pluck",
  "logdrum",
  "spectral",
  "vocalchop",
  "drumsynth",
];

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
