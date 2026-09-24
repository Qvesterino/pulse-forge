import type { FactoryAsset } from "./manifest";
import { FACTORY_ASSETS } from "./manifest";

const SAMPLE_RATE = 44100;

export class SampleBank {
  private buffers = new Map<string, AudioBuffer>();
  private sampleAddedListeners = new Set<(id: string) => void>();

  add(id: string, buffer: AudioBuffer): void {
    const isNew = !this.buffers.has(id);
    this.buffers.set(id, buffer);
    if (isNew) this.notifySampleAdded(id);
  }

  get(id: string | null): AudioBuffer | undefined {
    return id ? this.buffers.get(id) : undefined;
  }

  has(id: string | null): boolean {
    return id ? this.buffers.has(id) : false;
  }

  remove(id: string): void {
    this.buffers.delete(id);
  }

  get size(): number {
    return this.buffers.size;
  }

  entries(): [string, AudioBuffer][] {
    return [...this.buffers.entries()];
  }

  /**
   * Subscribe to FIRST arrivals of a sample id (overwriting an existing id
   * does not fire — consumers re-syncing on it would just redo work). The
   * reload race this serves: worklet-backed instrument runtimes (granular /
   * wavetable voices) bake their sample at construction and never see the
   * boot restore's later `bank.add` — the engine re-uploads to them here.
   */
  onSampleAdded(listener: (id: string) => void): () => void {
    this.sampleAddedListeners.add(listener);
    return () => this.sampleAddedListeners.delete(listener);
  }

  private notifySampleAdded(id: string): void {
    for (const listener of this.sampleAddedListeners) listener(id);
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(ctx: OfflineAudioContext, seconds: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(seed);
  for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
  return buffer;
}

type Builder = (ctx: OfflineAudioContext, dest: AudioNode) => void;

async function render(duration: number, build: Builder): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  build(ctx, ctx.destination);
  return ctx.startRendering();
}

function env(ctx: OfflineAudioContext, t0: number, peak: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0005, t0 + decay);
  return g;
}

function noiseSource(ctx: OfflineAudioContext, seed: number, duration: number, t0: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = makeNoise(ctx, duration, seed);
  src.start(t0);
  return src;
}

function kick(startHz: number, endHz: number, decay: number, click: number, drive = 0): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(startHz, t0);
    osc.frequency.exponentialRampToValueAtTime(endHz, t0 + Math.min(0.09, decay * 0.4));
    const amp = env(ctx, t0, 1, decay);
    osc.connect(amp);
    if (drive > 0) {
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(new ArrayBuffer(1024 * 4));
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(x * (1 + drive * 4));
      }
      shaper.curve = curve;
      amp.connect(shaper).connect(dest);
    } else {
      amp.connect(dest);
    }
    osc.start(t0);
    osc.stop(t0 + decay + 0.02);
    if (click > 0) {
      const noise = noiseSource(ctx, 11, 0.01, t0);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1500;
      noise
        .connect(hp)
        .connect(env(ctx, t0, click, 0.012))
        .connect(dest);
    }
  };
}

function snare(toneHz: number, toneDecay: number, noiseDecay: number, noiseHz: number): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(toneHz, t0);
    osc.frequency.exponentialRampToValueAtTime(toneHz * 0.6, t0 + toneDecay);
    osc.connect(env(ctx, t0, 0.7, toneDecay)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + toneDecay + 0.02);
    const noise = noiseSource(ctx, 22, noiseDecay + 0.05, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = noiseHz;
    bp.Q.value = 0.9;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.8, noiseDecay))
      .connect(dest);
  };
}

/** Hard crack snare: short bright tone + hard bandpassed noise + a click
 * transient on top — the drill/jersey backbeat character (reads through a
 * dense mix at 140+ BPM where a longer snare smears). */
function snareCrack(opts: {
  toneHz: number;
  toneDecay: number;
  noiseHz: number;
  noiseDecay: number;
  click: number;
  seed: number;
}): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(opts.toneHz, t0);
    osc.frequency.exponentialRampToValueAtTime(opts.toneHz * 0.62, t0 + opts.toneDecay);
    osc.connect(env(ctx, t0, 0.72, opts.toneDecay)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + opts.toneDecay + 0.02);
    const noise = noiseSource(ctx, opts.seed, opts.noiseDecay + 0.05, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = opts.noiseHz;
    bp.Q.value = 1.4;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.85, opts.noiseDecay))
      .connect(dest);
    if (opts.click > 0) {
      const click = noiseSource(ctx, opts.seed + 1, 0.015, t0);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 3000;
      click
        .connect(hp)
        .connect(env(ctx, t0, opts.click, 0.012))
        .connect(dest);
    }
  };
}

/** Dusty snare: tone through a lowpass + dark softened noise — phonk/lo-fi
 * backbeat (the noise reads as tape grit, not bristle). */
function snareDusty(opts: {
  toneHz: number;
  toneDecay: number;
  noiseHz: number;
  noiseDecay: number;
  seed: number;
}): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(opts.toneHz, t0);
    osc.frequency.exponentialRampToValueAtTime(opts.toneHz * 0.6, t0 + opts.toneDecay);
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 2600;
    osc
      .connect(env(ctx, t0, 0.7, opts.toneDecay))
      .connect(lpf)
      .connect(dest);
    osc.start(t0);
    osc.stop(t0 + opts.toneDecay + 0.02);
    const noise = noiseSource(ctx, opts.seed, opts.noiseDecay + 0.05, t0);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = opts.noiseHz;
    noise
      .connect(lp)
      .connect(env(ctx, t0, 0.75, opts.noiseDecay))
      .connect(dest);
  };
}

/** Metallic hat: highpassed noise plus a short square-wave ping bank —
 * the tight Jersey/DnB hats that cut as groove markers, not just sizzle. */
function hatMetallic(opts: {
  decay: number;
  hpHz: number;
  level: number;
  pingHz: number;
  ping: number;
  seed: number;
}): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, opts.seed, opts.decay + 0.05, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = opts.hpHz;
    noise
      .connect(hp)
      .connect(env(ctx, t0, opts.level, opts.decay))
      .connect(dest);
    if (opts.ping > 0) {
      const ping = ctx.createOscillator();
      ping.type = "square";
      ping.frequency.value = opts.pingHz;
      const bpf = ctx.createBiquadFilter();
      bpf.type = "bandpass";
      bpf.frequency.value = opts.pingHz;
      bpf.Q.value = 9;
      ping
        .connect(bpf)
        .connect(env(ctx, t0, opts.ping, Math.min(0.06, opts.decay)))
        .connect(dest);
      ping.start(t0);
      ping.stop(t0 + 0.08);
    }
  };
}

function clap(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.011;
      const noise = noiseSource(ctx, 33 + i, 0.02, t);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1150;
      bp.Q.value = 1.6;
      noise
        .connect(bp)
        .connect(env(ctx, t, 0.55, 0.018))
        .connect(dest);
    }
    const tail = noiseSource(ctx, 44, 0.3, t0 + 0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1100;
    bp.Q.value = 1.1;
    tail
      .connect(bp)
      .connect(env(ctx, t0 + 0.03, 0.5, 0.16))
      .connect(dest);
  };
}

function hat(decay: number, hpHz: number, level: number): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 55, decay + 0.05, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = hpHz;
    noise
      .connect(hp)
      .connect(env(ctx, t0, level, decay))
      .connect(dest);
  };
}

function tom(startHz: number, endHz: number): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(startHz, t0);
    osc.frequency.exponentialRampToValueAtTime(endHz, t0 + 0.22);
    osc.connect(env(ctx, t0, 0.9, 0.34)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.4);
  };
}

function blip(fromHz: number, toHz: number, decay: number): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(fromHz, t0);
    osc.frequency.exponentialRampToValueAtTime(toHz, t0 + decay);
    osc.connect(env(ctx, t0, 0.8, decay)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + decay + 0.02);
  };
}

function rim(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 1720;
    osc.connect(env(ctx, t0, 0.35, 0.035)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.06);
    const noise = noiseSource(ctx, 66, 0.02, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3200;
    bp.Q.value = 2;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.4, 0.02))
      .connect(dest);
  };
}

function shaker(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 77, 0.15, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 5600;
    bp.Q.value = 1.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.1);
    noise.connect(bp).connect(g).connect(dest);
  };
}

function ride(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 88, 0.9, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 6200;
    noise
      .connect(hp)
      .connect(env(ctx, t0, 0.28, 0.6))
      .connect(dest);
    const ping = ctx.createOscillator();
    ping.type = "square";
    ping.frequency.value = 3400;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3400;
    bp.Q.value = 9;
    ping
      .connect(bp)
      .connect(env(ctx, t0, 0.2, 0.14))
      .connect(dest);
    ping.start(t0);
    ping.stop(t0 + 0.2);
  };
}

function tick(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 99, 0.02, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2100;
    bp.Q.value = 4;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.6, 0.018))
      .connect(dest);
  };
}

const C4 = 261.63;

function pluck(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = C4;
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = C4 * 2.003;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    osc.connect(env(ctx, t0, 0.85, 0.38)).connect(dest);
    osc2
      .connect(g2)
      .connect(env(ctx, t0, 0.5, 0.18))
      .connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.45);
    osc2.start(t0);
    osc2.stop(t0 + 0.25);
  };
}

function stab(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const ratios = [1, 1.26, 1.498];
    ratios.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = C4 * ratio * (1 + (i - 1) * 0.0012);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2400;
      osc
        .connect(lp)
        .connect(env(ctx, t0, 0.3, 0.34))
        .connect(dest);
      osc.start(t0);
      osc.stop(t0 + 0.42);
    });
  };
}

function keys(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const parts: [OscillatorType, number, number][] = [
      ["sine", C4, 0.6],
      ["sine", C4 * 2, 0.25],
      ["triangle", C4 * 3.01, 0.08],
    ];
    for (const [type, freq, level] of parts) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(env(ctx, t0, level, 0.9)).connect(dest);
      osc.start(t0);
      osc.stop(t0 + 1.0);
    }
  };
}

/** Memphis/phonk guitar hook: saw+triangle through a warm LPF with a slow
 * vibrato and a dusted attack — the dusty six-string that carries memphis
 * melodies. */
function memphisGuitar(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 2100;
    lpf.Q.value = 1.1;
    const vib = ctx.createOscillator();
    vib.type = "sine";
    vib.frequency.value = 5.2;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 4.5;
    vib.connect(vibGain);
    for (const [type, mult, level, decay] of [
      ["sawtooth", 1, 0.55, 0.85],
      ["triangle", 1.002, 0.4, 0.7],
      ["sine", 2.004, 0.18, 0.4],
    ] as [OscillatorType, number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(C4 * mult, t0);
      vibGain.connect(osc.detune);
      osc.connect(env(ctx, t0, level, decay)).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + decay + 0.1);
    }
    vib.start(t0);
    vib.stop(t0 + 1.2);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.9, t0);
    amp.gain.setTargetAtTime(0.0001, t0 + 0.7, 0.3);
    lpf.connect(amp).connect(dest);
    const grit = noiseSource(ctx, 71, 0.02, t0);
    const ghp = ctx.createBiquadFilter();
    ghp.type = "highpass";
    ghp.frequency.value = 2500;
    grit
      .connect(ghp)
      .connect(env(ctx, t0, 0.06, 0.015))
      .connect(dest);
  };
}

/** Dark string ensemble: three detuned saws + fifth through a heavy LPF,
 * slow swell, long tail — the drill/melodic-trap menace bed. */
function darkStrings(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 1600;
    lpf.Q.value = 0.8;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(0.8, t0 + 0.18);
    amp.gain.setTargetAtTime(0.0001, t0 + 0.55, 0.5);
    lpf.connect(amp).connect(dest);
    for (const [mult, level] of [
      [1, 0.34],
      [1.0045, 0.3],
      [0.9957, 0.3],
      [1.5, 0.14],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(C4 * mult, t0);
      osc.connect(env(ctx, t0, level, 1.6)).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 1.9);
    }
  };
}

/** Rhodes-ish tine: sine body + bright FM-ish tine partial that decays
 * fast — the warm electric key the sampler never had. */
function rhodes(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.value = C4;
    const bodyG = env(ctx, t0, 0.7, 1.4);
    body.connect(bodyG).connect(dest);
    body.start(t0);
    body.stop(t0 + 1.6);
    const tine = ctx.createOscillator();
    tine.type = "sine";
    tine.frequency.setValueAtTime(C4 * 3.98, t0);
    tine.frequency.exponentialRampToValueAtTime(C4 * 3.02, t0 + 0.25);
    const tineG = env(ctx, t0, 0.3, 0.3);
    tine.connect(tineG).connect(dest);
    tine.start(t0);
    tine.stop(t0 + 0.5);
    const bark = ctx.createOscillator();
    bark.type = "triangle";
    bark.frequency.value = C4 * 2;
    bark.connect(env(ctx, t0, 0.12, 0.5)).connect(dest);
    bark.start(t0);
    bark.stop(t0 + 0.7);
  };
}

/** Mariachi trumpet: saw through a brassy bandpass formant with a pitch
 * flare on the attack and late vibrato — the phonk icon. */
function mariachiTrumpet(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(C4 * 0.985, t0);
    osc.frequency.exponentialRampToValueAtTime(C4 * 1.004, t0 + 0.09);
    const vib = ctx.createOscillator();
    vib.type = "sine";
    vib.frequency.value = 5.6;
    const vibGain = ctx.createGain();
    vibGain.gain.setValueAtTime(0.0001, t0);
    vibGain.gain.linearRampToValueAtTime(9, t0 + 0.5);
    vib.connect(vibGain).connect(osc.detune);
    vib.start(t0);
    vib.stop(t0 + 1.0);
    const formant = ctx.createBiquadFilter();
    formant.type = "bandpass";
    formant.frequency.value = 1150;
    formant.Q.value = 1.6;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(0.85, t0 + 0.045);
    amp.gain.setTargetAtTime(0.0001, t0 + 0.6, 0.25);
    osc.connect(formant).connect(amp).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 1.1);
    const edge = noiseSource(ctx, 73, 0.015, t0);
    const ehp = ctx.createBiquadFilter();
    ehp.type = "highpass";
    ehp.frequency.value = 3200;
    edge
      .connect(ehp)
      .connect(env(ctx, t0, 0.07, 0.012))
      .connect(dest);
  };
}

/** Anime/game pluck: bright sine stack with a sparkle partial and short
 * decay — kawaii/jersey melody ear candy. */
function animePluck(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (const [mult, level, decay] of [
      [1, 0.6, 0.3],
      [2.01, 0.3, 0.2],
      [3.02, 0.18, 0.14],
      [4.04, 0.1, 0.1],
    ] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = C4 * 2 * mult;
      osc.connect(env(ctx, t0, level, decay)).connect(dest);
      osc.start(t0);
      osc.stop(t0 + decay + 0.1);
    }
  };
}

/** Sad piano: layered sines with staggered decays under a dark LPF — the
 * melodic trap / drill heartbreak note. */
function sadPiano(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 2400;
    lpf.connect(dest);
    for (const [mult, level, decay] of [
      [1, 0.6, 1.7],
      [2.002, 0.25, 0.9],
      [3.004, 0.1, 0.45],
      [4.998, 0.05, 0.25],
    ] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = C4 * mult;
      osc.connect(env(ctx, t0, level, decay)).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + decay + 0.2);
    }
    const hammer = noiseSource(ctx, 79, 0.012, t0);
    const hlp = ctx.createBiquadFilter();
    hlp.type = "lowpass";
    hlp.frequency.value = 3000;
    hammer
      .connect(hlp)
      .connect(env(ctx, t0, 0.08, 0.01))
      .connect(dest);
  };
}

/** Warm pad swell: detuned triangles breathing in — the lo-fi/dnb intro
 * bed that sits under everything. */
function padWarm(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 1800;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(0.75, t0 + 0.5);
    amp.gain.setTargetAtTime(0.0001, t0 + 1.3, 0.6);
    lpf.connect(amp).connect(dest);
    for (const [mult, type, level] of [
      [1, "triangle", 0.4],
      [1.006, "sine", 0.3],
      [0.5, "sine", 0.25],
      [1.5, "triangle", 0.15],
    ] as [number, OscillatorType, number][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = C4 * mult;
      osc.connect(env(ctx, t0, level, 2.4)).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 2.7);
    }
  };
}

/** Harp tone: five-partial cascade with fast staggered decays — the dnb
 * liquid / score gliss grain. */
function harpTone(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    // Faster, fingered decays than the keys stack + a nail transient on the
    // attack — without it the harp measured 0.973-correlated with tonal.keys
    // (a duplicate, not a second voice).
    const parts: [number, number, number][] = [
      [1, 0.5, 0.75],
      [2.001, 0.3, 0.5],
      [3.003, 0.18, 0.36],
      [4.005, 0.1, 0.26],
      [5.01, 0.06, 0.18],
    ];
    for (const [mult, level, decay] of parts) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = C4 * mult;
      osc.connect(env(ctx, t0, level, decay)).connect(dest);
      osc.start(t0);
      osc.stop(t0 + decay + 0.12);
    }
    const nail = noiseSource(ctx, 83, 0.012, t0);
    const nbp = ctx.createBiquadFilter();
    nbp.type = "bandpass";
    nbp.frequency.value = 3600;
    nbp.Q.value = 2;
    nail
      .connect(nbp)
      .connect(env(ctx, t0, 0.12, 0.01))
      .connect(dest);
  };
}

function bell(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const parts: [number, number][] = [
      [523.25, 0.55],
      [1046.5, 0.28],
      [1568, 0.14],
      [2093, 0.06],
    ];
    for (const [freq, level] of parts) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(env(ctx, t0, level, 1.3)).connect(dest);
      osc.start(t0);
      osc.stop(t0 + 1.45);
    }
  };
}

function sub808(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(38, t0 + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, t0);
    g.gain.setTargetAtTime(0.0005, t0 + 0.1, 0.28);
    osc.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 1.1);
    const click = noiseSource(ctx, 12, 0.02, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2000;
    click
      .connect(hp)
      .connect(env(ctx, t0, 0.18, 0.015))
      .connect(dest);
  };
}

/** Sustained 808 body with drive: sine sweep + tanh sat + tail smoothing.
 * The backbone of drill/phonk 808s — the drive pushes harmonics into the
 * mids so the note reads on small speakers, the LPF keeps the fizz down. */
function sub808Drive(opts: {
  startHz: number;
  endHz: number;
  dropSec: number;
  tailSec: number;
  tau: number;
  drive: number;
  lpfHz: number;
  click: number;
}): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(opts.startHz, t0);
    osc.frequency.exponentialRampToValueAtTime(opts.endHz, t0 + opts.dropSec);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, t0);
    g.gain.setTargetAtTime(0.0005, t0 + opts.tailSec, opts.tau);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(new ArrayBuffer(1024 * 4));
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * (1 + opts.drive * 4));
    }
    shaper.curve = curve;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = opts.lpfHz;
    osc.connect(g).connect(shaper).connect(lpf).connect(dest);
    osc.start(t0);
    osc.stop(t0 + opts.tailSec + opts.tau * 5);
    if (opts.click > 0) {
      const click = noiseSource(ctx, 12, 0.02, t0);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2000;
      click
        .connect(hp)
        .connect(env(ctx, t0, opts.click, 0.015))
        .connect(dest);
    }
  };
}

/** Vintage thump: mid-forward body through real saturation + a dusty grit
 * layer under a lowpass — the phonk/lo-fi family share this shape. */
function vintageThump(opts: {
  startHz: number;
  endHz: number;
  decay: number;
  drive: number;
  lpfHz: number;
  gritHz: number;
  gritGain: number;
  seed: number;
}): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(opts.startHz, t0);
    osc.frequency.exponentialRampToValueAtTime(opts.endHz, t0 + Math.min(0.09, opts.decay * 0.4));
    const amp = env(ctx, t0, 1, opts.decay);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(new ArrayBuffer(1024 * 4));
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * (1 + opts.drive * 4));
    }
    shaper.curve = curve;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = opts.lpfHz;
    osc.connect(amp).connect(shaper).connect(lpf).connect(dest);
    osc.start(t0);
    osc.stop(t0 + opts.decay + 0.02);
    const grit = noiseSource(ctx, opts.seed, 0.03, t0);
    const gritLp = ctx.createBiquadFilter();
    gritLp.type = "lowpass";
    gritLp.frequency.value = opts.gritHz;
    grit
      .connect(gritLp)
      .connect(env(ctx, t0, opts.gritGain, 0.022))
      .connect(dest);
  };
}

/** 90s knock: sub body plus a short mid-band "knock" hit layered on top —
 * the boom-bap / RnB punch that reads through a dusty mix. */
function knock(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.07);
    osc.connect(env(ctx, t0, 0.9, 0.32)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.36);
    const knocker = ctx.createOscillator();
    knocker.type = "triangle";
    knocker.frequency.setValueAtTime(192, t0);
    knocker.frequency.exponentialRampToValueAtTime(150, t0 + 0.06);
    const kShaper = ctx.createWaveShaper();
    const kCurve = new Float32Array(new ArrayBuffer(1024 * 4));
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      kCurve[i] = Math.tanh(x * 1.8);
    }
    kShaper.curve = kCurve;
    knocker
      .connect(env(ctx, t0, 0.5, 0.09))
      .connect(kShaper)
      .connect(dest);
    knocker.start(t0);
    knocker.stop(t0 + 0.12);
  };
}

function snarePunch(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(200, t0);
    osc.frequency.exponentialRampToValueAtTime(150, t0 + 0.08);
    osc.connect(env(ctx, t0, 0.85, 0.09)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.12);
    const noise = noiseSource(ctx, 23, 0.26, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1900;
    bp.Q.value = 1.1;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.9, 0.22))
      .connect(dest);
    // body thump
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(180, t0);
    body.frequency.exponentialRampToValueAtTime(90, t0 + 0.1);
    body.connect(env(ctx, t0, 0.4, 0.1)).connect(dest);
    body.start(t0);
    body.stop(t0 + 0.14);
  };
}

function snareTrap(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(240, t0);
    osc.frequency.exponentialRampToValueAtTime(160, t0 + 0.05);
    osc.connect(env(ctx, t0, 0.7, 0.06)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.08);
    const noise = noiseSource(ctx, 31, 0.16, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2600;
    noise
      .connect(hp)
      .connect(env(ctx, t0, 0.85, 0.14))
      .connect(dest);
  };
}

function clapSoft(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.014;
      const noise = noiseSource(ctx, 34 + i, 0.02, t);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1050;
      bp.Q.value = 1.4;
      noise
        .connect(bp)
        .connect(env(ctx, t, 0.4, 0.02))
        .connect(dest);
    }
    const tail = noiseSource(ctx, 45, 0.34, t0 + 0.04);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1000;
    bp.Q.value = 1.0;
    tail
      .connect(bp)
      .connect(env(ctx, t0 + 0.04, 0.34, 0.22))
      .connect(dest);
  };
}

function rideBell(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noises = noiseSource(ctx, 89, 1.2, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    noises
      .connect(hp)
      .connect(env(ctx, t0, 0.16, 1.1))
      .connect(dest);
    const ping = ctx.createOscillator();
    ping.type = "square";
    ping.frequency.value = 4800;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 4800;
    bp.Q.value = 12;
    ping
      .connect(bp)
      .connect(env(ctx, t0, 0.18, 0.55))
      .connect(dest);
    ping.start(t0);
    ping.stop(t0 + 0.6);
  };
}

function crash(bandHz: number, decay: number, level: number): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 91, decay + 0.1, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = bandHz;
    bp.Q.value = 0.4;
    noise
      .connect(bp)
      .connect(env(ctx, t0, level, decay))
      .connect(dest);
    const shimmer = noiseSource(ctx, 92, 0.2, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 9000;
    shimmer
      .connect(hp)
      .connect(env(ctx, t0, level * 0.5, 0.12))
      .connect(dest);
  };
}

function cowbell(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (const [freq, level] of [
      [545, 0.5],
      [810, 0.35],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 2;
      osc
        .connect(bp)
        .connect(env(ctx, t0, level, 0.28))
        .connect(dest);
      osc.start(t0);
      osc.stop(t0 + 0.32);
    }
  };
}

function conga(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(230, t0);
    osc.frequency.exponentialRampToValueAtTime(160, t0 + 0.06);
    osc.connect(env(ctx, t0, 0.7, 0.22)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.3);
    const noise = noiseSource(ctx, 71, 0.08, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 1.5;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.6, 0.06))
      .connect(dest);
  };
}

function tambourine(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      const t = t0 + i * 0.035;
      const noise = noiseSource(ctx, 74 + i, 0.04, t);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 7000;
      noise
        .connect(hp)
        .connect(env(ctx, t, 0.4 - i * 0.05, 0.03))
        .connect(dest);
    }
  };
}

/** Bandpass-filtered noise whose center sweeps between two frequencies. */
function sweepNoise(
  fromHz: number,
  toHz: number,
  duration: number,
  gainShape: "up" | "down" | "both",
  peak: number,
): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 101, duration + 0.05, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(fromHz, t0);
    const g = ctx.createGain();
    const mid = t0 + duration / 2;
    if (gainShape === "up") {
      bp.frequency.exponentialRampToValueAtTime(toHz, t0 + duration);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + duration);
    } else if (gainShape === "down") {
      bp.frequency.exponentialRampToValueAtTime(toHz, t0 + duration);
      g.gain.setValueAtTime(peak, t0);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + duration);
    } else {
      bp.frequency.exponentialRampToValueAtTime(toHz, mid);
      bp.frequency.exponentialRampToValueAtTime(fromHz, t0 + duration);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, mid);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + duration);
    }
    noise.connect(bp).connect(g).connect(dest);
  };
}

function fxRiser(): Builder {
  return sweepNoise(280, 8500, 1.9, "up", 0.8);
}

function fxDownlifter(): Builder {
  return sweepNoise(8500, 220, 1.9, "down", 0.75);
}

function fxImpact(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(85, t0);
    thump.frequency.exponentialRampToValueAtTime(30, t0 + 0.4);
    thump.connect(env(ctx, t0, 1, 0.8)).connect(dest);
    thump.start(t0);
    thump.stop(t0 + 1);
    const noise = noiseSource(ctx, 102, 0.5, t0);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    noise
      .connect(lp)
      .connect(env(ctx, t0, 0.65, 0.4))
      .connect(dest);
    const punch = noiseSource(ctx, 103, 0.05, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    punch
      .connect(hp)
      .connect(env(ctx, t0, 0.8, 0.04))
      .connect(dest);
  };
}

function fxSweep(): Builder {
  return sweepNoise(400, 6000, 1.4, "both", 0.55);
}

function fxReverse(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 104, 1.15, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.0;
    bp.frequency.setValueAtTime(900, t0);
    bp.frequency.exponentialRampToValueAtTime(7000, t0 + 1.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.8, t0 + 1.05);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 1.14);
    noise.connect(bp).connect(g).connect(dest);
  };
}

function fxNoise(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 105, 0.3, t0);
    noise.connect(env(ctx, t0, 0.7, 0.25)).connect(dest);
  };
}

/** Exported for the content-coherence tests (tests/kick-bank.test.ts). */
export const BUILDERS: Record<string, Builder> = {
  "factory.kick.deep": kick(150, 46, 0.42, 0.25),
  "factory.kick.punch": kick(210, 54, 0.28, 0.45),
  "factory.kick.techno": kick(175, 44, 0.55, 0.3, 0.7),
  "factory.kick.sub808": sub808(),
  "factory.kick.trap": kick(180, 48, 0.35, 0.4, 0.45),
  "factory.kick.soft": kick(118, 44, 0.46, 0.16),
  // Kick bank expansion (2026-09): genre-anchored one-shots — the 808
  // family (drive/pure/drill), the vintage pair (phonk/lofi), and the
  // club/heritage punches (jersey/dnb/knock/909). Each targets a distinct
  // spectral+decay pocket so a beat can actually pick between them.
  "factory.kick.808drive": sub808Drive({
    startHz: 150,
    endHz: 36,
    dropSec: 0.5,
    tailSec: 0.12,
    tau: 0.32,
    drive: 0.55,
    lpfHz: 6000,
    click: 0.15,
  }),
  "factory.kick.808pure": sub808Drive({
    startHz: 140,
    endHz: 34,
    dropSec: 0.45,
    tailSec: 0.14,
    tau: 0.42,
    drive: 0,
    lpfHz: 4000,
    click: 0,
  }),
  "factory.kick.drill": sub808Drive({
    startHz: 175,
    endHz: 42,
    dropSec: 0.06,
    tailSec: 0.1,
    tau: 0.16,
    drive: 0.4,
    lpfHz: 5500,
    click: 0.3,
  }),
  "factory.kick.phonk": vintageThump({
    startHz: 130,
    endHz: 50,
    decay: 0.3,
    drive: 0.5,
    lpfHz: 3200,
    gritHz: 1200,
    gritGain: 0.08,
    seed: 31,
  }),
  "factory.kick.jersey": kick(205, 56, 0.22, 0.55),
  "factory.kick.dnb": kick(170, 52, 0.26, 0.5),
  "factory.kick.lofi": vintageThump({
    startHz: 115,
    endHz: 48,
    decay: 0.3,
    drive: 0.25,
    lpfHz: 2600,
    gritHz: 900,
    gritGain: 0.1,
    seed: 37,
  }),
  "factory.kick.knock": knock(),
  "factory.kick.909": kick(290, 52, 0.3, 0.6, 0.15),
  "factory.rim.chip": rim(),
  "factory.snare.main": snare(192, 0.11, 0.2, 1750),
  "factory.snare.tight": snare(210, 0.07, 0.11, 2000),
  "factory.snare.punch": snarePunch(),
  "factory.snare.trap": snareTrap(),
  // Snare/hat bank expansion (2026-09): genre backbeats + groove hats for
  // the beatmaking genres (drill crack, phonk/lofi dust, jersey club, dnb
  // break) — same design goal as the kick bank: distinct pockets, not
  // variations of one sound.
  "factory.snare.drill": snareCrack({
    toneHz: 232,
    toneDecay: 0.07,
    noiseHz: 2100,
    noiseDecay: 0.13,
    click: 0.5,
    seed: 41,
  }),
  "factory.snare.phonk": snareDusty({ toneHz: 186, toneDecay: 0.12, noiseHz: 1700, noiseDecay: 0.2, seed: 43 }),
  "factory.snare.jersey": snareCrack({
    toneHz: 240,
    toneDecay: 0.06,
    noiseHz: 2400,
    noiseDecay: 0.11,
    click: 0.7,
    seed: 47,
  }),
  "factory.snare.dnb": snareCrack({
    toneHz: 210,
    toneDecay: 0.11,
    noiseHz: 1900,
    noiseDecay: 0.19,
    click: 0.3,
    seed: 53,
  }),
  "factory.snare.lofi": snareDusty({ toneHz: 172, toneDecay: 0.1, noiseHz: 1300, noiseDecay: 0.17, seed: 59 }),
  "factory.hat.drill": hat(0.035, 9200, 0.5),
  "factory.hat.phonk": hat(0.07, 4200, 0.4),
  "factory.hat.jersey": hatMetallic({ decay: 0.055, hpHz: 8200, level: 0.55, pingHz: 6400, ping: 0.3, seed: 61 }),
  "factory.hat.dnb": hatMetallic({ decay: 0.04, hpHz: 9600, level: 0.5, pingHz: 7100, ping: 0.24, seed: 67 }),
  "factory.hat.open.cup": hatMetallic({ decay: 0.28, hpHz: 5200, level: 0.42, pingHz: 4600, ping: 0.22, seed: 71 }),
  "factory.clap.main": clap(),
  "factory.clap.soft": clapSoft(),
  "factory.shaker.soft": shaker(),
  "factory.hat.closed": hat(0.055, 7400, 0.55),
  "factory.hat.closed.soft": hat(0.04, 5800, 0.32),
  "factory.hat.open": hat(0.36, 7000, 0.5),
  "factory.hat.open.short": hat(0.18, 6800, 0.42),
  "factory.hat.pedal": hat(0.035, 4600, 0.24),
  "factory.ride.ping": ride(),
  "factory.ride.bell": rideBell(),
  "factory.crash.main": crash(8200, 1.3, 0.6),
  "factory.crash.dark": crash(5200, 1.7, 0.5),
  "factory.tom.low": tom(150, 92),
  "factory.tom.mid": tom(185, 120),
  "factory.tom.high": tom(220, 150),
  "factory.perc.tick": tick(),
  "factory.perc.blip": blip(880, 620, 0.09),
  "factory.perc.cowbell": cowbell(),
  "factory.perc.conga": conga(),
  "factory.perc.tambourine": tambourine(),
  "factory.fx.riser": fxRiser(),
  "factory.fx.downlifter": fxDownlifter(),
  "factory.fx.impact": fxImpact(),
  "factory.fx.sweep": fxSweep(),
  "factory.fx.reverse": fxReverse(),
  "factory.fx.noise": fxNoise(),
  "factory.tonal.pluck": pluck(),
  "factory.tonal.stab": stab(),
  "factory.tonal.keys": keys(),
  "factory.tonal.bell": bell(),
  // Tonal bank expansion (2026-09): the "real instrument" voices beatmaking
  // actually reaches for — memphis guitar, drill strings, rhodes, mariachi
  // trumpet, anime pluck, sad piano, warm pad, harp. Carriers for sampler
  // AND vocalchop presets (the chop engine formats tonal carriers).
  "factory.tonal.memphisguitar": memphisGuitar(),
  "factory.tonal.darkstrings": darkStrings(),
  "factory.tonal.rhodes": rhodes(),
  "factory.tonal.trumpet": mariachiTrumpet(),
  "factory.tonal.animepluck": animePluck(),
  "factory.tonal.sadpiano": sadPiano(),
  "factory.tonal.padwarm": padWarm(),
  "factory.tonal.harp": harpTone(),
};

/** Render length per asset, seconds — exported for coherence tests. */
export const DURATIONS: Record<string, number> = {
  "factory.kick.deep": 0.5,
  "factory.kick.punch": 0.35,
  "factory.kick.techno": 0.65,
  "factory.kick.sub808": 1.2,
  "factory.kick.trap": 0.45,
  "factory.kick.soft": 0.6,
  "factory.kick.808drive": 1.3,
  "factory.kick.808pure": 1.5,
  "factory.kick.drill": 0.6,
  "factory.kick.phonk": 0.55,
  "factory.kick.jersey": 0.4,
  "factory.kick.dnb": 0.42,
  "factory.kick.lofi": 0.5,
  "factory.kick.knock": 0.5,
  "factory.kick.909": 0.45,
  "factory.rim.chip": 0.08,
  "factory.snare.main": 0.3,
  "factory.snare.tight": 0.2,
  "factory.snare.punch": 0.32,
  "factory.snare.trap": 0.22,
  "factory.snare.drill": 0.2,
  "factory.snare.phonk": 0.32,
  "factory.snare.jersey": 0.18,
  "factory.snare.dnb": 0.28,
  "factory.snare.lofi": 0.3,
  "factory.hat.drill": 0.1,
  "factory.hat.phonk": 0.12,
  "factory.hat.jersey": 0.12,
  "factory.hat.dnb": 0.1,
  "factory.hat.open.cup": 0.32,
  "factory.clap.main": 0.3,
  "factory.clap.soft": 0.36,
  "factory.shaker.soft": 0.2,
  "factory.hat.closed": 0.12,
  "factory.hat.closed.soft": 0.1,
  "factory.hat.open": 0.45,
  "factory.hat.open.short": 0.26,
  "factory.hat.pedal": 0.08,
  "factory.ride.ping": 0.8,
  "factory.ride.bell": 1.3,
  "factory.crash.main": 1.7,
  "factory.crash.dark": 1.9,
  "factory.tom.low": 0.45,
  "factory.tom.mid": 0.45,
  "factory.tom.high": 0.45,
  "factory.perc.tick": 0.05,
  "factory.perc.blip": 0.15,
  "factory.perc.cowbell": 0.36,
  "factory.perc.conga": 0.32,
  "factory.perc.tambourine": 0.3,
  "factory.fx.riser": 2.0,
  "factory.fx.downlifter": 2.0,
  "factory.fx.impact": 1.1,
  "factory.fx.sweep": 1.5,
  "factory.fx.reverse": 1.25,
  "factory.fx.noise": 0.35,
  "factory.tonal.pluck": 0.5,
  "factory.tonal.stab": 0.5,
  "factory.tonal.keys": 1.1,
  "factory.tonal.bell": 1.5,
  "factory.tonal.memphisguitar": 1.4,
  "factory.tonal.darkstrings": 2.2,
  "factory.tonal.rhodes": 1.8,
  "factory.tonal.trumpet": 1.3,
  "factory.tonal.animepluck": 0.5,
  "factory.tonal.sadpiano": 2.2,
  "factory.tonal.padwarm": 2.8,
  "factory.tonal.harp": 1.4,
};

/**
 * Round-robin variations — micro-different clones of the beat-critical
 * drums (±~1.5% pitch/length, ±4% level). Mapped into overlapping sampler
 * layer zones they kill the "machine-gun" effect of repeated identical
 * hits. Derived from the rendered base (not re-synthesized) so every
 * variation keeps the base character while no two hits are identical.
 * Each entry generates `<base>.rr2`, `<base>.rr3`, … into the bank.
 */
export const RR_VARIATIONS: Record<string, Array<{ rate: number; gain: number }>> = {
  "factory.snare.main": [
    { rate: 1.018, gain: 1.04 },
    { rate: 0.984, gain: 0.95 },
  ],
  "factory.snare.punch": [
    { rate: 1.014, gain: 1.03 },
    { rate: 0.988, gain: 0.96 },
  ],
  "factory.hat.closed": [
    { rate: 1.022, gain: 1.05 },
    { rate: 0.98, gain: 0.94 },
  ],
  "factory.hat.open.short": [
    { rate: 1.016, gain: 1.04 },
    { rate: 0.986, gain: 0.95 },
  ],
  "factory.kick.punch": [
    { rate: 1.012, gain: 1.03 },
    { rate: 0.99, gain: 0.96 },
  ],
  "factory.kick.jersey": [
    { rate: 1.014, gain: 1.03 },
    { rate: 0.988, gain: 0.95 },
  ],
  "factory.kick.dnb": [
    { rate: 1.01, gain: 1.04 },
    { rate: 0.992, gain: 0.95 },
  ],
  "factory.kick.drill": [
    { rate: 1.008, gain: 1.03 },
    { rate: 0.994, gain: 0.96 },
  ],
  "factory.kick.909": [
    { rate: 1.011, gain: 1.03 },
    { rate: 0.991, gain: 0.96 },
  ],
  "factory.snare.drill": [
    { rate: 1.009, gain: 1.03 },
    { rate: 0.993, gain: 0.96 },
  ],
  "factory.snare.dnb": [
    { rate: 1.012, gain: 1.04 },
    { rate: 0.99, gain: 0.95 },
  ],
  "factory.hat.jersey": [
    { rate: 1.015, gain: 1.03 },
    { rate: 0.988, gain: 0.95 },
  ],
  "factory.hat.dnb": [
    { rate: 1.013, gain: 1.04 },
    { rate: 0.99, gain: 0.95 },
  ],
};

/** Derive one variation: linear-resample (pitch + length together) and scale. */
function deriveVariation(src: AudioBuffer, rate: number, gain: number): AudioBuffer {
  const length = Math.max(1, Math.round(src.length / rate));
  const out = new AudioBuffer({ numberOfChannels: src.numberOfChannels, length, sampleRate: src.sampleRate });
  for (let ch = 0; ch < src.numberOfChannels; ch++) {
    const s = src.getChannelData(ch);
    const d = out.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const pos = i * rate;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = s[i0] ?? 0;
      const b = i0 + 1 < s.length ? s[i0 + 1] : a;
      d[i] = (a + (b - a) * frac) * gain;
    }
  }
  return out;
}

const FACTORY_RENDER_PARALLEL = 4;

export async function generateFactoryBank(): Promise<SampleBank> {
  const bank = new SampleBank();
  const assets: FactoryAsset[] = FACTORY_ASSETS;
  // Bounded render pool (quality backlog B7): 69 concurrent
  // OfflineAudioContexts spiked memory and serialized inside the browser
  // anyway — a small worker pool (same shape as the curated layer) keeps
  // boot TTI predictable on weak machines.
  const queue = [...assets];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const asset = queue.shift()!;
      const builder = BUILDERS[asset.id];
      if (!builder) throw new Error(`No builder for factory asset ${asset.id}`);
      const buffer = await render(DURATIONS[asset.id] ?? 0.3, builder);
      bank.add(asset.id, buffer);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FACTORY_RENDER_PARALLEL, assets.length) }, worker));
  for (const [baseId, variations] of Object.entries(RR_VARIATIONS)) {
    const base = bank.get(baseId);
    if (!base) throw new Error(`No base buffer for RR variation of ${baseId}`);
    variations.forEach(({ rate, gain }, i) => {
      bank.add(`${baseId}.rr${i + 2}`, deriveVariation(base, rate, gain));
    });
  }
  return bank;
}
