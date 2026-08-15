import type { FactoryAsset } from "./manifest";
import { FACTORY_ASSETS } from "./manifest";

const SAMPLE_RATE = 44100;

export class SampleBank {
  private buffers = new Map<string, AudioBuffer>();

  add(id: string, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
  }

  get(id: string | null): AudioBuffer | undefined {
    return id ? this.buffers.get(id) : undefined;
  }

  get size(): number {
    return this.buffers.size;
  }

  entries(): [string, AudioBuffer][] {
    return [...this.buffers.entries()];
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
      noise.connect(hp).connect(env(ctx, t0, click, 0.012)).connect(dest);
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
    noise.connect(bp).connect(env(ctx, t0, 0.8, noiseDecay)).connect(dest);
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
      noise.connect(bp).connect(env(ctx, t, 0.55, 0.018)).connect(dest);
    }
    const tail = noiseSource(ctx, 44, 0.3, t0 + 0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1100;
    bp.Q.value = 1.1;
    tail.connect(bp).connect(env(ctx, t0 + 0.03, 0.5, 0.16)).connect(dest);
  };
}

function hat(decay: number, hpHz: number, level: number): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 55, decay + 0.05, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = hpHz;
    noise.connect(hp).connect(env(ctx, t0, level, decay)).connect(dest);
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
    noise.connect(bp).connect(env(ctx, t0, 0.4, 0.02)).connect(dest);
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
    noise.connect(hp).connect(env(ctx, t0, 0.28, 0.6)).connect(dest);
    const ping = ctx.createOscillator();
    ping.type = "square";
    ping.frequency.value = 3400;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3400;
    bp.Q.value = 9;
    ping.connect(bp).connect(env(ctx, t0, 0.2, 0.14)).connect(dest);
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
    noise.connect(bp).connect(env(ctx, t0, 0.6, 0.018)).connect(dest);
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
    osc2.connect(g2).connect(env(ctx, t0, 0.5, 0.18)).connect(dest);
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
      osc.connect(lp).connect(env(ctx, t0, 0.3, 0.34)).connect(dest);
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

const BUILDERS: Record<string, Builder> = {
  "factory.kick.deep": kick(150, 46, 0.42, 0.25),
  "factory.kick.punch": kick(210, 54, 0.28, 0.45),
  "factory.kick.techno": kick(175, 44, 0.55, 0.3, 0.7),
  "factory.rim.chip": rim(),
  "factory.snare.main": snare(192, 0.11, 0.2, 1750),
  "factory.snare.tight": snare(210, 0.07, 0.11, 2000),
  "factory.clap.main": clap(),
  "factory.shaker.soft": shaker(),
  "factory.hat.closed": hat(0.055, 7400, 0.55),
  "factory.hat.closed.soft": hat(0.04, 5800, 0.32),
  "factory.hat.open": hat(0.36, 7000, 0.5),
  "factory.ride.ping": ride(),
  "factory.tom.low": tom(150, 92),
  "factory.tom.high": tom(220, 150),
  "factory.perc.tick": tick(),
  "factory.perc.blip": blip(880, 620, 0.09),
  "factory.tonal.pluck": pluck(),
  "factory.tonal.stab": stab(),
  "factory.tonal.keys": keys(),
  "factory.tonal.bell": bell(),
};

const DURATIONS: Record<string, number> = {
  "factory.kick.deep": 0.5,
  "factory.kick.punch": 0.35,
  "factory.kick.techno": 0.65,
  "factory.rim.chip": 0.08,
  "factory.snare.main": 0.3,
  "factory.snare.tight": 0.2,
  "factory.clap.main": 0.3,
  "factory.shaker.soft": 0.2,
  "factory.hat.closed": 0.12,
  "factory.hat.closed.soft": 0.1,
  "factory.hat.open": 0.45,
  "factory.ride.ping": 0.8,
  "factory.tom.low": 0.45,
  "factory.tom.high": 0.45,
  "factory.perc.tick": 0.05,
  "factory.perc.blip": 0.15,
  "factory.tonal.pluck": 0.5,
  "factory.tonal.stab": 0.5,
  "factory.tonal.keys": 1.1,
  "factory.tonal.bell": 1.5,
};

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
  return bank;
}
