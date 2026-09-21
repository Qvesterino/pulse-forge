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

const BUILDERS: Record<string, Builder> = {
  "factory.kick.deep": kick(150, 46, 0.42, 0.25),
  "factory.kick.punch": kick(210, 54, 0.28, 0.45),
  "factory.kick.techno": kick(175, 44, 0.55, 0.3, 0.7),
  "factory.kick.sub808": sub808(),
  "factory.kick.trap": kick(180, 48, 0.35, 0.4, 0.45),
  "factory.kick.soft": kick(118, 44, 0.46, 0.16),
  "factory.rim.chip": rim(),
  "factory.snare.main": snare(192, 0.11, 0.2, 1750),
  "factory.snare.tight": snare(210, 0.07, 0.11, 2000),
  "factory.snare.punch": snarePunch(),
  "factory.snare.trap": snareTrap(),
  "factory.clap.main": clap(),
  "factory.clap.soft": clapSoft(),
  "factory.shaker.soft": shaker(),
  "factory.hat.closed": hat(0.055, 7400, 0.55),
  "factory.hat.closed.soft": hat(0.04, 5800, 0.32),
  "factory.hat.open": hat(0.36, 7000, 0.5),
  "factory.hat.open.short": hat(0.18, 6800, 0.42),
  "factory.hat.pedal": hat(0.03, 5000, 0.26),
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
};

const DURATIONS: Record<string, number> = {
  "factory.kick.deep": 0.5,
  "factory.kick.punch": 0.35,
  "factory.kick.techno": 0.65,
  "factory.kick.sub808": 1.2,
  "factory.kick.trap": 0.45,
  "factory.kick.soft": 0.6,
  "factory.rim.chip": 0.08,
  "factory.snare.main": 0.3,
  "factory.snare.tight": 0.2,
  "factory.snare.punch": 0.32,
  "factory.snare.trap": 0.22,
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

export async function generateFactoryBank(): Promise<SampleBank> {
  const bank = new SampleBank();
  const assets: FactoryAsset[] = FACTORY_ASSETS;
  await Promise.all(
    assets.map(async (asset) => {
      const builder = BUILDERS[asset.id];
      if (!builder) throw new Error(`No builder for factory asset ${asset.id}`);
      const buffer = await render(DURATIONS[asset.id] ?? 0.3, builder);
      bank.add(asset.id, buffer);
    }),
  );
  for (const [baseId, variations] of Object.entries(RR_VARIATIONS)) {
    const base = bank.get(baseId);
    if (!base) throw new Error(`No base buffer for RR variation of ${baseId}`);
    variations.forEach(({ rate, gain }, i) => {
      bank.add(`${baseId}.rr${i + 2}`, deriveVariation(base, rate, gain));
    });
  }
  return bank;
}
