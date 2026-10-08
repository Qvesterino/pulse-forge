import type { FactoryAsset } from "./manifest";
import { FACTORY_ASSETS } from "./manifest";

const SAMPLE_RATE = 44100;

export class SampleBank {
  private buffers = new Map<string, AudioBuffer>();
  private sampleAddedListeners = new Set<(id: string) => void>();
  private revisionListeners = new Set<(revision: number) => void>();
  private revisionValue = 0;

  /** Monotonic content revision for consumers that need stale-render checks. */
  get revision(): number {
    return this.revisionValue;
  }

  add(id: string, buffer: AudioBuffer): void {
    const previous = this.buffers.get(id);
    const isNew = previous === undefined;
    if (previous !== buffer) {
      this.revisionValue++;
      this.notifyRevisionChanged();
    }
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
    if (this.buffers.delete(id)) {
      this.revisionValue++;
      this.notifyRevisionChanged();
    }
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

  /** Subscribe to any content change, including replacing or removing an existing sample. */
  onRevisionChanged(listener: (revision: number) => void): () => void {
    this.revisionListeners.add(listener);
    return () => {
      this.revisionListeners.delete(listener);
    };
  }

  private notifySampleAdded(id: string): void {
    for (const listener of this.sampleAddedListeners) listener(id);
  }

  private notifyRevisionChanged(): void {
    for (const listener of this.revisionListeners) listener(this.revisionValue);
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

/** Roomy backbeat snare (library gap: house/boom-bap depth) — a dry crack
 * (triangle body + weight thump + wire noise) plus a synthesized room: three
 * discrete early-reflection taps of the dry path over a diffuse, darkened
 * noise tail. The room path is high-passed at 240 Hz so the space adds
 * DEPTH, not mud — a room mic's low end is what turns a backbeat into wash.
 * The only bank snare with a tail; sits behind house and boom-bap backbeats. */
function snareRoom(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const dry = ctx.createGain();
    dry.connect(dest);
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(196, t0);
    osc.frequency.exponentialRampToValueAtTime(122, t0 + 0.07);
    osc.connect(env(ctx, t0, 0.75, 0.1)).connect(dry);
    osc.start(t0);
    osc.stop(t0 + 0.14);
    const weight = ctx.createOscillator();
    weight.type = "sine";
    weight.frequency.setValueAtTime(170, t0);
    weight.frequency.exponentialRampToValueAtTime(118, t0 + 0.05);
    weight.connect(env(ctx, t0, 0.45, 0.09)).connect(dry);
    weight.start(t0);
    weight.stop(t0 + 0.12);
    const wires = noiseSource(ctx, 113, 0.2, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1750;
    bp.Q.value = 0.9;
    wires
      .connect(bp)
      .connect(env(ctx, t0, 0.85, 0.17))
      .connect(dry);
    // Room path — everything past the highpass is space, not the hit.
    const roomHp = ctx.createBiquadFilter();
    roomHp.type = "highpass";
    roomHp.frequency.value = 240;
    dry.connect(roomHp);
    // Early reflections: the discrete echoes that read as "walls".
    for (const [ms, level] of [
      [11, 0.38],
      [19, 0.28],
      [31, 0.19],
    ] as [number, number][]) {
      const tap = ctx.createDelay(0.06);
      tap.delayTime.value = ms / 1000;
      roomHp
        .connect(tap)
        .connect(env(ctx, t0 + ms / 1000, level, 0.05))
        .connect(dest);
    }
    // Diffuse tail: absorbed (dark) noise wash that blooms just after the hit.
    const tail = noiseSource(ctx, 127, 0.5, t0 + 0.012);
    const tailLp = ctx.createBiquadFilter();
    tailLp.type = "lowpass";
    tailLp.frequency.value = 3000;
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.0001, t0 + 0.012);
    tailGain.gain.linearRampToValueAtTime(0.5, t0 + 0.028);
    tailGain.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.44);
    tail.connect(tailLp).connect(tailGain).connect(dest);
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

/** Long open-hat wash (library gap: 4/4 offbeat sizzle) — every other bank
 * hat decays ≤ 97 ms, so an offbeat open hat can only tick where house and
 * trance grooves want it to BLOOM. The wash: two inharmonic square pings
 * through tight bandpasses (the metallic "ting" that keeps it a HAT — a
 * crash has no ping) over a long highpassed noise tail that darkens as it
 * decays, the way real cymbal wash absorbs. The tail env runs ~0.9 s so the
 * AUDIBLE ring (to −20 dB) spans the offbeat's full ~250 ms at 124 BPM. */
function hatWash(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (const [hz, level] of [
      [6400, 0.3],
      [8400, 0.22],
    ] as [number, number][]) {
      const ping = ctx.createOscillator();
      ping.type = "square";
      ping.frequency.value = hz;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = hz;
      bp.Q.value = 9;
      ping
        .connect(bp)
        .connect(env(ctx, t0, level, 0.12))
        .connect(dest);
      ping.start(t0);
      ping.stop(t0 + 0.16);
    }
    const noise = noiseSource(ctx, 131, 1.0, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(6800, t0);
    hp.frequency.exponentialRampToValueAtTime(4200, t0 + 0.7);
    noise
      .connect(hp)
      .connect(env(ctx, t0, 0.6, 0.9))
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
    bp.frequency.value = 1240;
    bp.Q.value = 1.1;
    tail
      .connect(bp)
      .connect(env(ctx, t0 + 0.03, 0.5, 0.11))
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

/** Phase-4 percussion tom (2026-10-04): bank-coherence fill. The four
 * toms (low, mid, high, floor) all have a 0.34 s sustained body. Perc
 * tom is the SHORT snap-tom: 0.12 s decay, mid-pitch (180 Hz, between
 * low and mid), and a 12% frequency drop instead of 0.4-octave. The
 * "trx/lofi tom fill" voice — punctuates a 16th-note groove without
 * singing. */
function tomPerc(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.exponentialRampToValueAtTime(158, t0 + 0.06);
    osc.connect(env(ctx, t0, 0.85, 0.12)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.15);
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

/** Pop rim — pitched-up tight click for backbeat layers. */
function rimPop(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 2050;
    osc.connect(env(ctx, t0, 0.3, 0.028)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.05);
    const noise = noiseSource(ctx, 67, 0.02, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3600;
    bp.Q.value = 2;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.35, 0.018))
      .connect(dest);
  };
}

/** Phase-4 hard rim (2026-10-04): bank-coherence fill. Rim.chip is dry
 * and bright; rim.pop is pitched-up tight. Hard rim sits between them:
 * pitched-DOWN (1400 Hz vs 1720-2050 Hz), LONGER body (45 ms vs 28-35),
 * and a wider noise bandpass. The techno/house rim that punches through
 * a wall of sub-bass. */
function rimHard(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 1400;
    osc.connect(env(ctx, t0, 0.45, 0.045)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.07);
    const noise = noiseSource(ctx, 145, 0.03, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2800;
    bp.Q.value = 1.6;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.35, 0.025))
      .connect(dest);
  };
}

/** Phase-4 snap rim (2026-10-04): bank-coherence fill. The trx/lo-fi
 * "ghost rim" — short (35 ms), high-mid only (4500 Hz), no tonal body.
 * A click that reads as a hi-passed wood tap, not a snare hit. Used
 * for 16th-note ghost grooves and 808 clap substitutions.
 * Phase-4 follow-up 1: the first pass (15 ms, level 0.45) rendered
 * at -16.7 LUFS (3.7 dB under the -13 Rim target) — a 15 ms noise
 * burst is too short for the momentary-max analyzer to read.
 * Phase-4 follow-up 2: doubled the level (0.45 -> 0.95) but the
 * peak ceiling (-1.8 dBFS) capped the master trim. Final pass
 * lengthens the burst to 35 ms (still reads as a "snap", not a body)
 * and keeps level 0.95. */
function rimSnap(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 146, 0.04, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 4500;
    bp.Q.value = 2.5;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.95, 0.035))
      .connect(dest);
  };
}

/** Pop shaker — brighter, slightly longer driving shaker for pop 8ths. */
function shakerPop(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 78, 0.16, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 6800;
    bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.12);
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

/**
 * PERCUSSION FLAVOR PACK (percussion pack wave) — four voices that fill the
 * wooden/clicky gap between conga (low, long) and tick (high, shortest):
 * woodblock = resonant WOOD cavity (two close modes), clave = the dry 3-2
 * son click (higher, shorter, sharper), snapstack = finger snaps in a
 * staggered roll (not palm claps — higher, thinner), shaker.long = the
 * slow-groove seed shaker (soft attack, long tail).
 */

/** Woodblock: two close resonant modes (980/1540 Hz) over a fast strike —
 * the wooden CAVITY rings, so it's tonal-ish, not a click. */
function woodblock(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (const [hz, level, decay] of [
      [980, 0.6, 0.07],
      [1540, 0.42, 0.045],
    ] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = hz;
      osc.connect(env(ctx, t0, level, decay)).connect(dest);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
    }
    const strike = noiseSource(ctx, 191, 0.008, t0);
    strike.connect(env(ctx, t0, 0.3, 0.006)).connect(dest);
  };
}

/** Clave: the son clave — DRY, HIGH, SHARP. Two modes (2210/2960), decay
 * under 40 ms, no resonance tail. The anti-woodblock: all attack, no cavity. */
function clave(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (const [hz, level, decay] of [
      [2210, 0.6, 0.032],
      [2960, 0.4, 0.022],
    ] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = hz;
      osc.connect(env(ctx, t0, level, decay)).connect(dest);
      osc.start(t0);
      osc.stop(t0 + decay + 0.03);
    }
    const click = noiseSource(ctx, 197, 0.006, t0);
    click.connect(env(ctx, t0, 0.24, 0.005)).connect(dest);
  };
}

/** Snap stack: three finger snaps in a staggered roll (+0/+45/+90 ms) —
 * each snap is a high bandpassed click (~2800 Hz, <25 ms), quieter as the
 * roll falls off. NOT palm claps (those are the clap family's broad band). */
function snapstack(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (const [ms, level] of [
      [0, 0.5],
      [45, 0.4],
      [90, 0.3],
    ] as [number, number][]) {
      const t = t0 + ms / 1000;
      const snap = noiseSource(ctx, 211 + ms, 0.018, t);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2800;
      bp.Q.value = 1.6;
      snap
        .connect(bp)
        .connect(env(ctx, t, level, 0.02))
        .connect(dest);
    }
  };
}

/** Long shaker: the slow-groove seed shaker — soft 12 ms attack ramp (the
 * seeds SWISH, not tick) and a 0.4 s tail for ballad/neo-soul 16ths. */
function shakerLong(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 223, 0.45, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 4600;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.5, t0 + 0.012); // soft swish attack
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.42);
    noise.connect(bp).connect(g).connect(dest);
  };
}

const C4 = 261.63;

/** Saw lead — the workhorse mono lead: a saw at A3 with a slight detune
 * pair, medium-lowpass body and a fast-decaying vibrato-free envelope.
 * The "default melody voice" the lead lane never had — bright enough to
 * cut, dark enough to sit. */
function leadSaw(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 220; // A3
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 3200;
    lpf.Q.value = 0.7;
    lpf.connect(dest);
    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      osc.connect(env(ctx, t0, 0.3, 0.5)).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 1.1);
    }
  };
}

/** Supersaw — the big-room stack: seven detuned saws across ±22 cents with
 * a slow-attack body and a bright highpass shelf so the width reads even
 * on a mono render. The ANTHEM voice. */
function leadSupersaw(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 220; // A3
    const hpf = ctx.createBiquadFilter();
    hpf.type = "highpass";
    hpf.frequency.value = 180;
    hpf.connect(dest);
    const detunes = [-22, -15, -8, 0, 8, 15, 22];
    detunes.forEach((detune, index) => {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      osc.connect(env(ctx, t0, 0.13, 0.8)).connect(hpf);
      osc.start(t0 + index * 0.004);
      osc.stop(t0 + 1.4);
    });
  };
}

/** Square lead — the chiptune/eurodance lead: a hollow square at A3 with
 * PWM feel via a 2nd square an octave up at low level. Bright and
 * synthetic — the 8-bit/eurodance pocket. */
function leadSquare(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 220; // A3
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.01);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.04, 0.3);
    vca.connect(dest);
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = f;
    osc.connect(vca);
    osc.start(t0);
    osc.stop(t0 + 0.9);
    const oct = ctx.createOscillator();
    oct.type = "square";
    oct.frequency.value = f * 2;
    const g = ctx.createGain();
    g.gain.value = 0.22;
    oct.connect(g).connect(vca);
    oct.start(t0);
    oct.stop(t0 + 0.9);
  };
}

/** Lead pluck BRIGHT — the trance/progressive pluck: a saw at A4 through a
 * resonant lowpass with a FAST filter drop. The "pluck.lead" pocket the
 * tonal family's bright pluck fills on the tonal side; this one is the
 * LEAD side: brighter (5.6 kHz), longer (0.45 s), detune pair for width. */
function leadPluck(bright: boolean): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 440; // A4
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.setValueAtTime(bright ? 5600 : 1900, t0);
    lpf.frequency.exponentialRampToValueAtTime(bright ? 900 : 420, t0 + 0.3);
    lpf.Q.value = bright ? 1.9 : 1.1;
    lpf.connect(dest);
    const decay = bright ? 0.3 : 0.55;
    for (const detune of bright ? [-4, 4] : [0]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      osc.connect(env(ctx, t0, 0.34, decay)).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 0.9);
    }
  };
}

function pluck(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    // BRIGHT synthetic pluck (tonal de-homog 2026-10). Its manifest contract
    // is "Bright, Short" — the opposite end of the family from pizzicato
    // ("Plucked, Staccato", a dark string instrument). The old full-range
    // triangle stack measured 0.983-correlated with pizzicato over a full
    // second: same fundamental, same lowmid-dominated centroid (267 Hz), same
    // decay. So the split is structural: a bright resonant lowpass with a
    // lifted upper partial keeps the attack spark while pizzicato keeps the
    // string body.
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 5200;
    lpf.Q.value = 1.6; // resonant top — the "bright" in the contract
    lpf.connect(dest);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = C4;
    const body = ctx.createGain();
    body.gain.value = 0.45;
    osc
      .connect(body)
      .connect(env(ctx, t0, 0.85, 0.26))
      .connect(lpf);
    osc.start(t0);
    osc.stop(t0 + 0.32);
    // Upper-octave spark: the visible attack that separates it from pizzicato.
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = C4 * 4.0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    osc2
      .connect(g2)
      .connect(env(ctx, t0, 0.5, 0.12))
      .connect(dest);
    osc2.start(t0);
    osc2.stop(t0 + 0.18);
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
    // the 200A tremolo (de-homog wave 2026-10): an LFO on the whole voice —
    // keys has none, this wobble is the electric-piano fingerprint
    const trem = ctx.createGain();
    trem.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 4.8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.22;
    lfo.connect(lfoGain).connect(trem.gain);
    lfo.start(t0);
    lfo.stop(t0 + 1.9);
    trem.connect(dest);
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.value = C4;
    const bodyG = env(ctx, t0, 0.7, 1.6); // longer tail than keys
    body.connect(bodyG).connect(trem);
    body.start(t0);
    body.stop(t0 + 1.9);
    // Stable tine (sound-library audit 2026-10): the original partial glided
    // 3.98× → 3.02× (−32 %) across 250 ms, smearing the bell attack into an
    // audible downward chirp at −36…−40 dB (barely a tine at all). A Rhodes
    // tine rings AT a pitch — hold it at 4.02× so the attack reads as the
    // characteristic bright ping over the warm body.
    const tine = ctx.createOscillator();
    tine.type = "sine";
    tine.frequency.value = C4 * 4.02;
    const tineG = env(ctx, t0, 0.26, 0.3);
    tine.connect(tineG).connect(trem);
    tine.start(t0);
    tine.stop(t0 + 0.5);
    const bark = ctx.createOscillator();
    bark.type = "triangle";
    bark.frequency.value = C4 * 2;
    bark.connect(env(ctx, t0, 0.12, 0.5)).connect(trem);
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
 * melodic trap / drill heartbreak note. Tonal de-homog (2026-10): keys rings
 * as ONE clean voice; this one BLEEDS — a ±4¢ unison pair per partial (the
 * slow beating a depressed piano does), a darker 1900 Hz shade and a longer
 * sympathetic ring. The old recipe shared keys' exact 2400/1.7 s shape and
 * measured 0.980-correlated with it. */
function sadPiano(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 1900; // darker than keys (2400) — the heartbreak shade
    lpf.connect(dest);
    for (const [mult, level, decay] of [
      [1, 0.6, 2.4], // longer sympathetic ring than keys' 1.7
      [2.002, 0.28, 1.1],
      [3.004, 0.1, 0.5],
      [4.998, 0.05, 0.3],
    ] as [number, number, number][]) {
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = C4 * mult;
        osc.detune.value = detune;
        osc.connect(env(ctx, t0, level / 2, decay)).connect(lpf);
        osc.start(t0);
        osc.stop(t0 + decay + 0.2);
      }
    }
    const hammer = noiseSource(ctx, 79, 0.014, t0);
    const hlp = ctx.createBiquadFilter();
    hlp.type = "lowpass";
    hlp.frequency.value = 3000;
    hammer
      .connect(hlp)
      .connect(env(ctx, t0, 0.09, 0.012))
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

/** Harp tone: six-partial inharmonic cascade with fast staggered decays —
 * the dnb liquid / score gliss grain. Tonal de-homog (2026-10): a harp
 * string is NOT a harmonic series, so the partials sit at measured string
 * ratios (2.004 / 3.02 / 4.11 / 5.34 / 6.79) and each rings off at its own
 * rate — keys rings as one voice, the harp SPARKLES. The previous harmonic
 * stack measured 0.981-correlated with keys. */
function harpTone(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    // Inharmonic string ratios + the fastest staggered cascade in the bank.
    const parts: [number, number, number][] = [
      [1, 0.5, 0.5],
      [2.004, 0.32, 0.38],
      [3.02, 0.2, 0.3],
      [4.11, 0.12, 0.24],
      [5.34, 0.08, 0.18],
      [6.79, 0.05, 0.13],
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
      .connect(env(ctx, t0, 0.16, 0.012))
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
    // Glide rests on D#1 (sound-library audit 2026-09-29: sub-family glide
    // targets snapped to exact semitones — 30–70c off-key 808s beat against
    // tuned melodic content and give the sampler no honest root to transpose
    // from).
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(38.89, t0 + 0.4);
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
    osc.frequency.exponentialRampToValueAtTime(55.0, t0 + 0.07); // A1
    osc.connect(env(ctx, t0, 0.9, 0.32)).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.36);
    const knocker = ctx.createOscillator();
    knocker.type = "triangle";
    knocker.frequency.setValueAtTime(192, t0);
    knocker.frequency.exponentialRampToValueAtTime(146.83, t0 + 0.06); // D3
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

/**
 * BASS PACK (library-completion wave 2026-10-04) — the only empty category.
 * Five distinct bass voices, each a designed pocket a beat can pick between:
 * pure sub, reese, FM, pluck, LFO wobble, saturated dist. Every voice is
 * anchored on a semitone-clean root (D2 = 73.42 Hz; the sampler's root param
 * transposes) so tuned melodic content never beats against the bank.
 */

/** Clean sub — the pure round sine body: fundamental + touch of 2nd, soft
 * attack, long sustain. The default that always fits under an 808 or a kick. */
function bassClean(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 73.42; // D2
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.012);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.18, 0.55);
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 320;
    vca.connect(lpf).connect(dest);
    for (const [ratio, level] of [
      [1, 0.72],
      [2, 0.16],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + 1.4);
    }
  };
}

/** Reese — the classic two-saw detune beat: a pair of saws a few cents apart
 * under a lowpass. The growl comes from the beat frequency, not distortion,
 * so it reads as a bass rather than mud. */
function bassReese(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 73.42; // D2
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 1200;
    lpf.Q.value = 1.6;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.28;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 320;
    lfo.connect(lfoGain).connect(lpf.frequency);
    lfo.start(t0);
    lfo.stop(t0 + 1.9);
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(0.9, t0 + 0.02);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.7, 0.45);
    lpf.connect(vca).connect(dest);
    for (const [mult, level] of [
      [1, 0.4],
      [1.007, 0.4],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 1.8);
    }
    // Sub layer keeps the low end solid underneath the detune beat.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = f;
    sub.connect(env(ctx, t0, 0.3, 1.2)).connect(dest);
    sub.start(t0);
    sub.stop(t0 + 1.5);
  };
}

/** FM bass — the metallic hollow body: carrier sine with a fast-decaying
 * inharmonic modulator (ratio 3.5) → the bright "bell" bass of modern trap.
 * Higher ratio + index than the dist voice's harmonic drive keeps the two
 * spectrally apart (dist = odd-harmonic mid growl, FM = inharmonic clang). */
function bassFM(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 73.42; // D2
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = f * 3.5;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(950, t0);
    modGain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.26);
    mod.connect(modGain);
    const car = ctx.createOscillator();
    car.type = "sine";
    car.frequency.value = f;
    modGain.connect(car.frequency);
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(0.85, t0 + 0.008);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.25, 0.5);
    car.connect(vca).connect(dest);
    car.start(t0);
    car.stop(t0 + 1.6);
    mod.start(t0);
    mod.stop(t0 + 1.6);
    // Click transient for definition on small speakers.
    const click = noiseSource(ctx, 141, 0.012, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2400;
    click
      .connect(hp)
      .connect(env(ctx, t0, 0.16, 0.01))
      .connect(dest);
  };
}

/** Pluck bass — the short round house/bounce note: triangle body with a fast
 * decay and a bright pick transient. Leaves the sustain to the kick. Sits an
 * octave above the sub family (D3 — the classic pluck register) so the pack
 * covers both bass octaves instead of selling the same D2 body twice. */
function bassPluck(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 146.83; // D3
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.006);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.03, 0.12);
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 3000;
    lpf.Q.value = 2.4;
    vca.connect(lpf).connect(dest);
    for (const [ratio, level] of [
      [1, 0.55],
      [2, 0.22],
      [3, 0.09],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    }
    const pick = noiseSource(ctx, 143, 0.012, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 1.2;
    pick
      .connect(bp)
      .connect(env(ctx, t0, 0.22, 0.012))
      .connect(dest);
  };
}

/** 808 VELOCITY — the melodic-trap 808 as a velocity-expressive voice: a
 * pitch-dropping sine whose ATTACK CLICK, DRIVE and DECAY all scale with
 * velocity. This is the single-asset stand-in for the 3-zone velocity bank
 * (soft = short+clean, medium = medium drive, hard = long+driven): the
 * builder takes the velocity zone at render time, so the seed script emits
 * three WAVs from one voice. Zone parameters measured against the
 * sub808/808drive kicks so the melodic voice stays its own pocket. */
export function bass808(zone: "soft" | "medium" | "hard"): Builder {
  const cfg = {
    soft: { startHz: 90, endHz: 36.71, drive: 0.0, click: 0.12, decay: 0.35 }, // F1
    medium: { startHz: 120, endHz: 36.71, drive: 0.18, click: 0.3, decay: 0.55 },
    hard: { startHz: 150, endHz: 36.71, drive: 0.32, click: 0.45, decay: 0.85 },
  }[zone];
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.008);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.09, cfg.decay);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * (1 + cfg.drive * 6)) / Math.tanh(1 + cfg.drive * 6);
    }
    shaper.curve = curve;
    vca.connect(shaper).connect(dest);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(cfg.startHz, t0);
    osc.frequency.exponentialRampToValueAtTime(cfg.endHz, t0 + 0.07);
    osc.connect(vca);
    osc.start(t0);
    osc.stop(t0 + 1.6);
    if (cfg.click > 0) {
      const click = noiseSource(ctx, 71, 0.006, t0);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 900;
      click
        .connect(hp)
        .connect(env(ctx, t0, cfg.click, 0.01))
        .connect(dest);
    }
  };
}

/** Sub sine — the deep-house/techno sub layer: pure sine at F1 with the
 * barest 2nd harmonic so a phone speaker still hints the pitch. The quiet
 * counterpart to the 808's drive: no click, no pitch drop — a HELD sub. */
function bassSubSine(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 43.65; // F1
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.02);
    vca.gain.setValueAtTime(1, t0 + 1.1);
    vca.gain.setTargetAtTime(0.0005, t0 + 1.1, 0.18);
    vca.connect(dest);
    for (const [ratio, level] of [
      [1, 0.95],
      [2, 0.05],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + 1.8);
    }
  };
}

/** Sub square — the grime/dubstep sub: a square at F1 lowpassed just enough
 * to keep the odd harmonics (that hollow reed) without buzz. Sits between
 * the sine (pure) and the wobble (moving). */
function bassSubSquare(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 43.65; // F1
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.012);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.5, 0.5);
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 260;
    lpf.Q.value = 0.8;
    vca.connect(lpf).connect(dest);
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = f;
    osc.connect(vca);
    osc.start(t0);
    osc.stop(t0 + 1.8);
  };
}

/** Upright jazz bass — the walking-bass voice: a plucked fundamental at E1
 * with a soft thump body, short percussive attack (the finger), and a
 * woody 3rd partial. Dark and round — the anti-synth bass, which is the
 * point: jazz/boombap/lounge lanes finally have their instrument. */
function bassUpright(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 41.2; // E1
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.01);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.06, 0.22);
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 480;
    vca.connect(lpf).connect(dest);
    for (const [ratio, level] of [
      [1, 0.78],
      [2, 0.1],
      [3, 0.07],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + 1.0);
    }
    // The finger thump: a soft low noise burst, the humanizing attack.
    const thump = noiseSource(ctx, 91, 0.03, t0);
    const lp2 = ctx.createBiquadFilter();
    lp2.type = "lowpass";
    lp2.frequency.value = 700;
    thump
      .connect(lp2)
      .connect(env(ctx, t0, 0.25, 0.03))
      .connect(dest);
  };
}

/** Acid bass — the 303 voice: a saw at C2 into a resonant lowpass whose
 * frequency SWEEPS with the envelope (the squelch). Two rata: `fast` is
 * the classic short accent (decay 0.14), `slow` the held filter-fodder
 * line (decay 0.5, deeper sweep). */
export function bassAcid(rate: "fast" | "slow"): Builder {
  const cfg = rate === "fast" ? { decay: 0.14, sweep: 2400, q: 7 } : { decay: 0.5, sweep: 3400, q: 9 };
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 65.41; // C2
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.setValueAtTime(cfg.sweep, t0);
    lpf.frequency.exponentialRampToValueAtTime(220, t0 + cfg.decay * 1.6);
    lpf.Q.value = cfg.q;
    lpf.connect(dest);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    osc.connect(lpf).connect(env(ctx, t0, 0.55, cfg.decay));
    osc.start(t0);
    osc.stop(t0 + 1.0);
    // Sub anchor under the squelch (a bare 303 thins on small speakers).
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = f;
    sub.connect(env(ctx, t0, 0.3, cfg.decay * 1.2)).connect(dest);
    sub.start(t0);
    sub.stop(t0 + 1.0);
  };
}

/** Wobble bass — the UKG/bassline/dubstep LFO growl: a saw+sub into a resonant
 * lowpass driven by a synced-feel 6.2 Hz LFO with a deep sweep. The faster,
 * deeper sweep is the genre's signature "bassline" bounce; the reese's slow
 * 0.28 Hz drift is a different motion entirely. One-shot length keeps it
 * loopable inside a beat. */
function bassWobble(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 73.42; // D2
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 420;
    lpf.Q.value = 7.5;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 6.2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 360;
    lfo.connect(lfoGain).connect(lpf.frequency);
    lfo.start(t0);
    lfo.stop(t0 + 1.9);
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(0.95, t0 + 0.01);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.85, 0.4);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(2.4 * x);
    }
    shaper.curve = curve;
    lpf.connect(shaper).connect(vca).connect(dest);
    for (const [type, mult, level] of [
      ["sawtooth", 1, 0.5],
      ["square", 0.5, 0.3],
    ] as [OscillatorType, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 1.8);
    }
  };
}

/** Dist bass — the saturated mid-forward voice: the same sine body driven hard
 * into a tanh shaper with the highs rolled back, so the harmonics read in the
 * phone band without fizzing. The phonk/drill distorted 808 companion. */
function bassDist(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 73.42; // D2
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f * 1.28, t0);
    osc.frequency.exponentialRampToValueAtTime(f, t0 + 0.045);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(4.6 * x);
    }
    shaper.curve = curve;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 1900;
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(0.9, t0 + 0.008);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.32, 0.42);
    osc.connect(shaper).connect(lpf).connect(vca).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 1.5);
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

/** Pop clap stack (clap.pop re-voice 2026-09-30): the shipped seed stacked
 * clap.main + clap.soft verbatim — once mastering pulled every clap to the
 * same target, the stack collapsed onto main (feature distance 0.051, the
 * tightest pair left in the library). Re-voiced into what "Stacked, Crisp"
 * always claimed: a denser 5-tap stack (a bigger room of clappers) through a
 * brighter bandpass, a snap transient on the attack, and a SHORT bright tail
 * that sits under a pop vocal instead of washing like the house clap. */
function clapPopStack(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    // GATED BRIGHT register: 2000 Hz center vs main/soft at ~1100 — the
    // crisp pop clap reads an octave of air above the house clap. Tap
    // spacing alone proved sub-perceptual (first pass moved taps, distance
    // stayed 0.046): register and decay are what separate claps.
    for (let i = 0; i < 5; i++) {
      const t = t0 + i * 0.008;
      const noise = noiseSource(ctx, 167 + i, 0.02, t);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2000;
      bp.Q.value = 1.3;
      noise
        .connect(bp)
        .connect(env(ctx, t, 0.52 - i * 0.04, 0.015))
        .connect(dest);
    }
    // Snap: highpassed click for the crisp attack edge.
    const snap = noiseSource(ctx, 173, 0.012, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3800;
    snap
      .connect(hp)
      .connect(env(ctx, t0, 0.34, 0.012))
      .connect(dest);
    // GATED tail: 80 ms and bright — the 80s pop clap stops on a dime
    // instead of washing (main rings 0.16 s, soft 0.22 s).
    const tail = noiseSource(ctx, 179, 0.2, t0 + 0.03);
    const tailBp = ctx.createBiquadFilter();
    tailBp.type = "bandpass";
    tailBp.frequency.value = 1750;
    tailBp.Q.value = 1.0;
    tail
      .connect(tailBp)
      .connect(env(ctx, t0 + 0.03, 0.4, 0.08))
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

/** Phase-4 dnb clap (2026-10-04): bank-coherence fill for the Clap category.
 * DnB's 170 BPM break backbeat wants a tight, dark, LONGER clap than main —
 * 4 stacked hits at 11ms spacing (vs main's 3) plus a 0.4s dark body that
 * sits below 1.2 kHz so it doesn't fight the snare crack. The dnb kit was
 * the only genre kit without a dedicated clap. */
function clapDnb(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * 0.011;
      const noise = noiseSource(ctx, 35 + i, 0.02, t);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 950;
      bp.Q.value = 1.5;
      noise
        .connect(bp)
        .connect(env(ctx, t, 0.5, 0.018))
        .connect(dest);
    }
    const tail = noiseSource(ctx, 46, 0.4, t0 + 0.044);
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 1200;
    tail
      .connect(lpf)
      .connect(env(ctx, t0 + 0.044, 0.4, 0.4))
      .connect(dest);
  };
}

/** Phase-4 traditional room clap (2026-10-04): bank-coherence fill. A
 * "roomy" clap — 5 tight stacked hits with slight pitch drift in the
 * bandpass (reads as multiple hands in a small room), 200 ms decaying
 * tail kept dark. Hip-hop/lo-fi/boom-bap want a clap that feels like
 * hands, not a 909 stack. */
function clapTrad(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      const t = t0 + i * 0.013;
      const noise = noiseSource(ctx, 36 + i, 0.02, t);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1000 - i * 30;
      bp.Q.value = 1.3;
      noise
        .connect(bp)
        .connect(env(ctx, t, 0.42 - i * 0.03, 0.02))
        .connect(dest);
    }
    const tail = noiseSource(ctx, 47, 0.32, t0 + 0.06);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 1.0;
    tail
      .connect(bp)
      .connect(env(ctx, t0 + 0.06, 0.32, 0.22))
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

/** Phase-4 ride splash (2026-10-04): bank-coherence fill. The Cymbal
 * category had only ride.ping and ride.bell — both long sustained voices.
 * A splash is a short, bright, high-pitched cymbal hit with a fast
 * decay and a metallic ping on top. Standard accent voice in the cymbal
 * family, distinct from crashes (which are bandpass-washy and
 * mid-low). */
function rideSplash(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 144, 0.5, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    noise
      .connect(hp)
      .connect(env(ctx, t0, 0.35, 0.4))
      .connect(dest);
    const ping = ctx.createOscillator();
    ping.type = "square";
    ping.frequency.value = 5600;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 5600;
    bp.Q.value = 10;
    ping
      .connect(bp)
      .connect(env(ctx, t0, 0.25, 0.35))
      .connect(dest);
    ping.start(t0);
    ping.stop(t0 + 0.4);
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

/** Pop splash (crash.pop re-voice 2026-09-30): the shipped seed was the SAME
 * bandpass-wash builder as crash.main with a different band — feature
 * distance 0.025, a duplicate, and darker than main despite the manifest
 * promising "Bright, Airy". Re-voiced into the pocket the pop lane wants:
 * highpassed AIR-forward body (not a mid wash), a soft metallic ping for
 * definition, and a fast decay that accents a vocal downbeat without washing
 * over it. */
function crashPopSplash(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    // Body: highpassed noise — air to the top of the band.
    const noise = noiseSource(ctx, 141, 1.1, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5500;
    noise
      .connect(hp)
      .connect(env(ctx, t0, 0.5, 0.75))
      .connect(dest);
    // Definition ping: the metallic partial that keeps it a cymbal hit.
    const ping = ctx.createOscillator();
    ping.type = "square";
    ping.frequency.value = 4300;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 4300;
    bp.Q.value = 8;
    ping
      .connect(bp)
      .connect(env(ctx, t0, 0.28, 0.18))
      .connect(dest);
    ping.start(t0);
    ping.stop(t0 + 0.25);
    // Sparkle tail: a whisper of top-air outliving the body.
    const air = noiseSource(ctx, 149, 1.2, t0);
    const airHp = ctx.createBiquadFilter();
    airHp.type = "highpass";
    airHp.frequency.value = 10500;
    air
      .connect(airHp)
      .connect(env(ctx, t0, 0.22, 0.9))
      .connect(dest);
  };
}

/** Phase-4 short crash (2026-10-04): bank-coherence fill. The bank had
 * only long crashes (1.3-1.7 s decay). A 0.4 s bright crash is the standard
 * accent voice for a vocal downbeat that should not wash over the next
 * bar. Brighter than crash.main (10 kHz vs 8.2 kHz), shorter decay, lower
 * level — accents don't carry the energy of a section break. */
function crashShort(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 142, 0.45, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 10000;
    bp.Q.value = 0.5;
    noise
      .connect(bp)
      .connect(env(ctx, t0, 0.55, 0.4))
      .connect(dest);
    const ping = ctx.createOscillator();
    ping.type = "square";
    ping.frequency.value = 5200;
    const pingBp = ctx.createBiquadFilter();
    pingBp.type = "bandpass";
    pingBp.frequency.value = 5200;
    pingBp.Q.value = 9;
    ping
      .connect(pingBp)
      .connect(env(ctx, t0, 0.22, 0.12))
      .connect(dest);
    ping.start(t0);
    ping.stop(t0 + 0.16);
  };
}

/** Phase-4 trash crash (2026-10-04): bank-coherence fill. The 80s / phonk /
 * industrial cymbal character: highpassed noise (so the body is GONE — only
 * the metallic edge remains), tight bandpass, fast decay. Reads as a
 * trashy, broken, lo-fi cymbal — perfect for dark pads and tape grit. */
function crashTrash(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const noise = noiseSource(ctx, 143, 0.4, t0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 4500;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 7500;
    bp.Q.value = 1.2;
    noise
      .connect(hp)
      .connect(bp)
      .connect(env(ctx, t0, 0.5, 0.35))
      .connect(dest);
    const ping = ctx.createOscillator();
    ping.type = "square";
    ping.frequency.value = 3900;
    const pingBp = ctx.createBiquadFilter();
    pingBp.type = "bandpass";
    pingBp.frequency.value = 3900;
    pingBp.Q.value = 6;
    ping
      .connect(pingBp)
      .connect(env(ctx, t0, 0.18, 0.18))
      .connect(dest);
    ping.start(t0);
    ping.stop(t0 + 0.22);
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

/** Cowbell variety (quality backlog: phonk/oriental pack) — the classic
 * two-square recipe (545/810 through per-osc bandpass) re-tuned per pocket:
 * phonk dark sits lower with a longer body and LPF, the memphis "scream"
 * pushes a WaveShaper edge, drill tightens with a highpass, bright adds a
 * shimmer square. Each targets a distinct spectral pocket so a phonk beat
 * can actually stack cowbells without phase-stacking. */
function cowbellDark(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 2800;
    lpf.connect(dest);
    for (const [freq, level] of [
      [400, 0.55],
      [570, 0.38],
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
        .connect(env(ctx, t0, level, 0.38))
        .connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 0.42);
    }
  };
}

function cowbellScream(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    // Memphis edge: soft-clip curve on a WaveShaper — real saturation (a
    // hot gain node alone would not distort, the OfflineAudioContext render
    // is float and never hard-clips internally).
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(2.2 * x);
    }
    shaper.curve = curve;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 4500;
    shaper.connect(lpf).connect(dest);
    for (const [freq, level] of [
      [620, 0.5],
      [890, 0.34],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 2.2;
      osc
        .connect(bp)
        .connect(env(ctx, t0, level * 1.6, 0.42))
        .connect(shaper);
      osc.start(t0);
      osc.stop(t0 + 0.46);
    }
  };
}

function cowbellDrill(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    // Tight steel (sound-library audit 2026-10): the original ran the stock
    // 545/810 pair under a mere 400 Hz HPF and measured 0.916 waveform-
    // correlated with factory.perc.cowbell — a copy, not a second voice. The
    // drill cowbell now lives an octave up (1090/1620 = the same classic
    // ratio), with a short metallic ping that gives it a tight steel edge.
    const hpf = ctx.createBiquadFilter();
    hpf.type = "highpass";
    hpf.frequency.value = 700;
    hpf.connect(dest);
    for (const [freq, level, ping] of [
      [1090, 0.5, 0],
      [1620, 0.3, 0.22],
    ] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 2.6;
      osc
        .connect(bp)
        .connect(env(ctx, t0, level, 0.11))
        .connect(hpf);
      osc.start(t0);
      osc.stop(t0 + 0.16);
      if (ping > 0) {
        const ring = ctx.createOscillator();
        ring.type = "square";
        ring.frequency.value = freq * 2.02;
        const ringBp = ctx.createBiquadFilter();
        ringBp.type = "bandpass";
        ringBp.frequency.value = freq * 2.02;
        ringBp.Q.value = 9;
        ring
          .connect(ringBp)
          .connect(env(ctx, t0, ping, 0.05))
          .connect(hpf);
        ring.start(t0);
        ring.stop(t0 + 0.08);
      }
    }
  };
}

function cowbellBright(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    for (const [freq, level] of [
      [740, 0.45],
      [1065, 0.32],
      [1400, 0.12],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 2.2;
      osc
        .connect(bp)
        .connect(env(ctx, t0, level, 0.24))
        .connect(dest);
      osc.start(t0);
      osc.stop(t0 + 0.28);
    }
  };
}

/** Sitar (quality backlog: oriental pack) — the jawari buzz: saw + a
 * slightly detuned square beat against the bridge, plus sympathetic shimmer
 * (octave + fifth partials) that fades in AFTER the pluck as the
 * sympathetic strings ring up. D3 anchor. */
function sitar(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 146.83; // D3
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 5200;
    lpf.connect(dest);
    const body = env(ctx, t0, 0.42, 1.6);
    body.connect(lpf);
    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = f;
    saw.connect(body);
    saw.start(t0);
    saw.stop(t0 + 1.9);
    // Jawari buzz: a square a quarter-tone sharp beats against the saw.
    const buzz = ctx.createOscillator();
    buzz.type = "square";
    buzz.frequency.value = f * 1.03;
    const buzzGain = ctx.createGain();
    buzzGain.gain.setValueAtTime(0.12, t0);
    buzz.connect(buzzGain).connect(lpf);
    buzz.start(t0);
    buzz.stop(t0 + 1.9);
    // Sympathetic shimmer: octave + fifth fade in after the pluck.
    for (const [ratio, level] of [
      [2.01, 0.1],
      [3.02, 0.06],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * ratio;
      osc.connect(env(ctx, t0 + 0.15, level, 1.7)).connect(lpf);
      osc.start(t0 + 0.15);
      osc.stop(t0 + 2);
    }
  };
}

/** Erhu (quality backlog: oriental pack) — the singing bowed nasal tone:
 * saw through a bow-resonance bandpass, delayed vibrato (the bow settles
 * before the hand starts rocking), detuned second bow for width. D4 anchor.
 * Sustained by design — a bowed note holds while the bow travels. */
function erhu(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 293.66; // D4
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1200;
    bp.Q.value = 0.8;
    bp.connect(dest);
    const body = env(ctx, t0, 0.4, 1.5);
    body.connect(bp);
    // Delayed vibrato: the LFO depth ramps in after the bow settles.
    const vibrato = ctx.createOscillator();
    vibrato.type = "sine";
    vibrato.frequency.value = 5.5;
    const vibGain = ctx.createGain();
    vibGain.gain.setValueAtTime(0, t0);
    vibGain.gain.linearRampToValueAtTime(14, t0 + 0.35);
    vibrato.connect(vibGain);
    vibrato.start(t0);
    vibrato.stop(t0 + 1.8);
    for (const detune of [0, 4]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      vibGain.connect(osc.detune);
      osc.connect(body);
      osc.start(t0);
      osc.stop(t0 + 1.8);
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
    // Hand strike re-voice (library-quality audit 2026-10-04): the slap used to
    // sit at 900 Hz / Q 1.5, inside the 160–230 Hz body's own harmonic region —
    // the voice measured as the muddiest file in the bank (low-mid 18 dB above
    // its mids, −45 dB in 2–6 kHz). A real conga's hand contact is broadband,
    // centred ~1.5 kHz, so the body keeps the tone and the slap carries the
    // attack.
    bp.frequency.value = 1500;
    bp.Q.value = 1.1;
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

/** Sub-drop FX (library gap: drill/trap transitions) — the pitch-falling sub
 * the riser/downlifter family lacks: a sine drops two octaves (C3 → C1, the
 * rest semitone-clean like the 808 bank) and lands LOUD, then fades. A soft
 * tanh edge keeps the glide readable on small speakers, and a whisper of
 * falling band-passed air gives the drop a ceiling. Sustained sub + the FX
 * tape drive would square (the 808pure failure), so the seed script runs
 * this slot at near-unity tape drive. */
function fxSubDrop(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(130.81, t0); // C3
    osc.frequency.exponentialRampToValueAtTime(32.7, t0 + 0.55); // C1 rest
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.95, t0 + 0.015);
    g.gain.setValueAtTime(0.95, t0 + 0.45);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 1.35);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(1.6 * x);
    }
    shaper.curve = curve;
    osc.connect(g).connect(shaper).connect(dest);
    osc.start(t0);
    osc.stop(t0 + 1.4);
    const air = noiseSource(ctx, 137, 0.6, t0);
    const airBp = ctx.createBiquadFilter();
    airBp.type = "bandpass";
    airBp.frequency.setValueAtTime(2400, t0);
    airBp.frequency.exponentialRampToValueAtTime(500, t0 + 0.6);
    airBp.Q.value = 1.2;
    air
      .connect(airBp)
      .connect(env(ctx, t0, 0.12, 0.55))
      .connect(dest);
  };
}

/** Vinyl crackle (library gap: the lo-fi/phonk texture bed) — a dusty
 * surface, not a one-shot: seeded dust ticks (tiny decaying impulses every
 * few ms), rare bigger pops, over a low hiss floor. The envelope is FLAT and
 * the process stationary, so the bed loops cleanly under a beat; deliberately
 * mid/treble only (300 Hz HPF) — no rumble, the 808 owns the floor. */
function fxVinyl(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const seconds = 4;
    const buf = ctx.createBuffer(1, Math.floor(seconds * SAMPLE_RATE), SAMPLE_RATE);
    const data = buf.getChannelData(0);
    const rand = mulberry32(151);
    // Hiss floor: quiet broadband dust.
    for (let i = 0; i < data.length; i++) data[i] = (rand() * 2 - 1) * 0.012;
    // Dust ticks: Poisson-ish arrivals, each a tiny decaying noise burst.
    let i = 0;
    while (i < data.length) {
      i += Math.floor((0.004 + rand() * 0.05) * SAMPLE_RATE);
      if (i >= data.length) break;
      const amp = 0.05 + rand() * 0.12;
      const len = 20 + Math.floor(rand() * 90); // 0.5–2.5 ms
      for (let k = 0; k < len && i + k < data.length; k++) {
        data[i + k] += (rand() * 2 - 1) * amp * (1 - k / len);
      }
    }
    // Pops: rare, larger, squared decay — the speck crossing the groove.
    for (let p = 0; p < 7; p++) {
      const at = Math.floor(rand() * (data.length - 2000));
      const amp = 0.3 + rand() * 0.35;
      const len = 150 + Math.floor(rand() * 500);
      for (let k = 0; k < len && at + k < data.length; k++) {
        data[at + k] += (rand() * 2 - 1) * amp * (1 - k / len) ** 2;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 8500;
    src.connect(hp).connect(lp).connect(dest);
    src.start(t0);
  };
}

/**
 * TRANSITION PACK (transition pack wave) — three quick-transition FX that
 * sit next to (not on top of) the existing long family: impact2 is the
 * CINEMATIC hit (impact stays the sub thump), riser-short is the 0.7 s
 * cliff (riser is the 1.9 s long build), noise-down is the falling AIR
 * (downlifter is the long tonal sweep).
 */

/** Cinematic impact: a 120→45 Hz thump (impact's 85→30 is subbier), a
 * crunchy bandpassed noise hit and a short inharmonic metal ring
 * (211/489/733 Hz — struck metal, not a chord). Reads as a trailer hit
 * next to impact's trailer-BOTTOM. */
function fxImpact2(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(120, t0);
    thump.frequency.exponentialRampToValueAtTime(45, t0 + 0.18);
    thump.connect(env(ctx, t0, 0.9, 0.55)).connect(dest);
    thump.start(t0);
    thump.stop(t0 + 0.7);
    const crunch = noiseSource(ctx, 141, 0.09, t0);
    const cbp = ctx.createBiquadFilter();
    cbp.type = "bandpass";
    cbp.frequency.value = 1800;
    cbp.Q.value = 0.8;
    crunch
      .connect(cbp)
      .connect(env(ctx, t0, 0.5, 0.09))
      .connect(dest);
    for (const [hz, level, decay] of [
      [211, 0.22, 0.6],
      [489, 0.14, 0.42],
      [733, 0.09, 0.3],
    ] as [number, number, number][]) {
      const ring = ctx.createOscillator();
      ring.type = "sine";
      ring.frequency.value = hz;
      ring.connect(env(ctx, t0 + 0.005, level, decay)).connect(dest);
      ring.start(t0);
      ring.stop(t0 + decay + 0.1);
    }
  };
}

/** Short riser: a 0.7 s steep noise sweep 400→6500 with the gain shaped so
 * the LOUDEST point is the LAST one — a cliff the drop can hang from.
 * riser (1.9 s) is the long build; this is the "quick catch-breath". */
function fxRiserShort(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const duration = 0.7;
    const noise = noiseSource(ctx, 161, duration + 0.05, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(400, t0);
    bp.frequency.exponentialRampToValueAtTime(6500, t0 + duration);
    const g = ctx.createGain();
    // quiet start, exponential acceleration — steeper than linear toward
    // the cliff edge so the drop after it reads BIGGER
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.85, t0 + duration);
    g.gain.setValueAtTime(0.0001, t0 + duration + 0.02);
    noise.connect(bp).connect(g).connect(dest);
  };
}

/** Noise-down: 0.8 s of falling AIR — white noise through a bandpass that
 * closes 5200→260 as the gain falls. The downlifter is the long TONAL
 * sweep; this is the exhale between sections. */
function fxNoiseDown(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const duration = 0.8;
    const noise = noiseSource(ctx, 173, duration + 0.05, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(5200, t0);
    bp.frequency.exponentialRampToValueAtTime(260, t0 + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t0);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + duration);
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

/**
 * Mallet family (quality backlog: mallet pack) — struck-bar synthesis.
 * Classic mallet bars ring at inharmonic partial ratios (vibraphone and
 * marimba tune their resonators to 1:4, the celesta stacks 1:3:6), so the
 * builder takes a partial table instead of a wave shape. Optional motor
 * tremolo (the vibes' rotating discs) and a woody/bright strike click that
 * bypasses the tremolo (the mallet contact happens before the motor is
 * audible). One C anchor per instrument; the sampler's root/pitch params
 * transpose.
 */
function mallet(opts: {
  fundamental: number;
  partials: Array<[number, number]>;
  decay: number;
  attack?: number;
  tremoloHz?: number;
  tremoloDepth?: number;
  clickLevel?: number;
  /**
   * Strike-noise centre in Hz (default 4× fundamental) and its band width.
   * The default puts the mallet contact at 4× the bar's fundamental, which is
   * right for the C4+ mallets (vibes/celesta/music box/kalimba all land in the
   * 2–4 kHz attack region) but wrong for the C3 marimba: 4 × 131 Hz = 524 Hz
   * sits inside the bar's own 2nd partial, so the "strike" read as extra body
   * and the voice shipped with a 55 dB hole above 2 kHz (library-quality audit
   * 2026-10-04). Low-anchored bars override these.
   */
  clickHz?: number;
  clickQ?: number;
  lpfHz?: number;
}): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const attack = opts.attack ?? 0.004;
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + attack);
    vca.gain.setTargetAtTime(0.0005, t0 + attack + 0.01, opts.decay / 3);
    let head: AudioNode = vca;
    if (opts.tremoloHz) {
      // Motor tremolo: a slow LFO ducks the post-strike gain — the classic
      // vibraphone shimmer. Depth is half-range so the tremolo never
      // phase-cancels the strike transient.
      const trem = ctx.createGain();
      trem.gain.value = 1 - (opts.tremoloDepth ?? 0.35) / 2;
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = opts.tremoloHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = (opts.tremoloDepth ?? 0.35) / 2;
      lfo.connect(lfoGain).connect(trem.gain);
      lfo.start(t0);
      lfo.stop(t0 + opts.decay + 1);
      vca.connect(trem);
      head = trem;
    }
    if (opts.lpfHz) {
      const lpf = ctx.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = opts.lpfHz;
      head.connect(lpf).connect(dest);
    } else {
      head.connect(dest);
    }
    for (const [ratio, level] of opts.partials) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = opts.fundamental * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + opts.decay + 1);
    }
    if (opts.clickLevel) {
      // Strike transient: short band-passed noise at the mallet-contact
      // frequency (default 4× fundamental), dry (pre-motor) — reads as the
      // mallet contact.
      //
      // STRIKE FIX (library-quality audit 2026-10-04, bug #1). This path used to
      // read as "inert": a strike at 0.34 and one at 1.1 rendered seeds measuring
      // identical in every band, envelope point, peak and crest. It was never
      // inert — a Q-1 band-pass passes only ~1/Q of a white-noise burst, so the
      // raw clickLevel landed ~14 dB *below* the bar's own attack ramp and stayed
      // there after normalization (probe, builder output before mastering: a 0.34
      // strike measured -25.1 dBFS in its first millisecond against a -4.5 dBFS
      // marimba bar — masked in all five voices, and celesta/kalimba shipped at
      // 0.12/0.2). Two changes make clickLevel mean what it says — the strike's
      // level at the mallet contact, on the same scale as the partial levels
      // above:
      //  - the white-noise band-pass gain sqrt(π·f0 / (2·Q·fs)) is compensated, so
      //    one number holds at any contact frequency or Q;
      //  - the burst decays in 1.2 ms instead of 4 ms — a mallet contact is a
      //    click, and a burst shorter than the measurement window keeps its whole
      //    level inside the first millisecond where the attack reads.
      const hz = opts.clickHz ?? opts.fundamental * 4;
      const q = opts.clickQ ?? 1;
      const bpGain = Math.sqrt((Math.PI * hz) / (2 * q * ctx.sampleRate));
      const click = noiseSource(ctx, 8, 0.02, t0);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = hz;
      bp.Q.value = q;
      click
        .connect(bp)
        .connect(env(ctx, t0, opts.clickLevel / Math.max(bpGain, 0.05), 0.0012))
        .connect(dest);
    }
  };
}

/** Wurli (quality backlog: keys upgrade) — the barkier electric piano:
 * strong 2nd/3rd harmonics (the midrange BARK a rhodes does not have),
 * deeper faster tremolo (the 200A pulse), softer highs. C4 anchor; the
 * sampler's root/pitch params transpose. */
function wurli(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const attack = 0.003;
    const decay = 1.9;
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + attack);
    vca.gain.setTargetAtTime(0.0005, t0 + attack + 0.01, decay / 3);
    // Tremolo: the 200A pulse — deeper and slower than a rhodes vibe.
    const trem = ctx.createGain();
    trem.gain.value = 0.72;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 4.6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.28;
    lfo.connect(lfoGain).connect(trem.gain);
    lfo.start(t0);
    lfo.stop(t0 + decay + 1);
    // Mid bark: a peaking push at the 2nd/3rd harmonic region.
    const bark = ctx.createBiquadFilter();
    bark.type = "peaking";
    bark.frequency.value = 620;
    bark.Q.value = 0.9;
    bark.gain.value = 4.5;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 7200;
    vca.connect(trem).connect(bark).connect(lpf).connect(dest);
    for (const [ratio, level] of [
      [1, 0.5],
      [2, 0.24],
      [3, 0.1],
      [4, 0.04],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 261.63 * ratio; // C4
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + decay + 1);
    }
  };
}

/** Organ (quality backlog: organ pack) — tonewheel drawbar synthesis: the
 * classic Hammond drawbar harmonics (16' sub, 5⅓' quint, 8' unison, 4', 2⅔',
 * 2', 1') as sine drawbars with live-appropriate levels, a percussive key
 * click on attack, and a slight vibrato-chorus leak. SUSTAINED by design —
 * an organ note holds while the key is down (2 s render; the sampler's
 * release tail carries the sustain). C4 anchor. */
function organ(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 261.63; // C4
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.012); // organ: fast but not percussive
    vca.gain.setValueAtTime(1, t0 + 1.7);
    vca.gain.linearRampToValueAtTime(0, t0 + 1.95);
    // Drawbars: [harmonic multiple, level] — 16'/5⅓'/8'/4'/2'/1'
    const drawbars: [number, number][] = [
      [0.5, 0.22],
      [1, 0.5],
      [1.5, 0.14],
      [2, 0.3],
      [3, 0.1],
      [4, 0.16],
      [6, 0.06],
      [8, 0.08],
    ];
    for (const [mult, level] of drawbars) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + 2);
    }
    // Key click: the tonewheel gate transient every organ player knows.
    const click = noiseSource(ctx, 6, 0.015, t0);
    const clickHp = ctx.createBiquadFilter();
    clickHp.type = "highpass";
    clickHp.frequency.value = 1800;
    click
      .connect(clickHp)
      .connect(env(ctx, t0, 0.14, 0.012))
      .connect(dest);
    // Chorus leak: a very quiet detuned second rank (the Ce-le-ii vibe).
    const leak = ctx.createOscillator();
    leak.type = "sine";
    leak.frequency.value = f * 1.003;
    const leakGain = ctx.createGain();
    leakGain.gain.value = 0.06;
    leak.connect(leakGain).connect(vca);
    leak.start(t0);
    leak.stop(t0 + 2);
    vca.connect(dest);
  };
}

/**
 * Acoustic guitar (quality backlog: the last sound holes) — steel-string
 * strum: bright pluck with strong 2nd partial, quick body decay, long
 * shimmer tail, and the string-scrape noise burst on attack. E2 anchor
 * (guitars live low); the sampler's root/pitch transposes.
 */
function acousticGuitar(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 82.41; // E2
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(1, t0);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.05, 0.55);
    // Bright top, warm body: parallel LPF (body) + full-range (shimmer).
    const body = ctx.createBiquadFilter();
    body.type = "lowpass";
    body.frequency.value = 2400;
    const shimmer = ctx.createGain();
    shimmer.gain.value = 0.35;
    vca.connect(body).connect(dest);
    vca.connect(shimmer).connect(dest);
    // Steel-string partials: fundamental + strong 2nd + a touch of 3rd/4th.
    for (const [ratio, level] of [
      [1, 0.55],
      [2, 0.3],
      [3, 0.1],
      [4, 0.05],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + 2.2);
    }
    // String scrape on attack.
    const scrape = noiseSource(ctx, 11, 0.03, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3200;
    bp.Q.value = 0.7;
    scrape
      .connect(bp)
      .connect(env(ctx, t0, 0.2, 0.02))
      .connect(dest);
  };
}

/**
 * Choir pad (quality backlog: the last sound holes) — the "aah" vocal bed:
 * formant-filtered detuned saws (two vowel formants stacked = the vocal
 * cavity), slow breath attack, chorus shimmer. A3 anchor (choir pads sit
 * mid-low); sustained by design.
 */
function choirPad(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 220; // A3
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(0.9, t0 + 0.9); // breath attack
    vca.gain.setTargetAtTime(0.0005, t0 + 1.2, 0.7);
    // Vocal cavity: two formant bandpasses (the "aah" pair).
    for (const [formant, q, level] of [
      [700, 5, 0.5],
      [1080, 6, 0.32],
    ] as [number, number, number][]) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = formant;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      vca.connect(bp).connect(g).connect(dest);
    }
    // Three detuned voices per side of the unison — the choir width.
    for (const detune of [-7, 0, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      osc.connect(vca);
      osc.start(t0);
      osc.stop(t0 + 3);
      // Octave whisper for the head-voice layer.
      const oct = ctx.createOscillator();
      oct.type = "triangle";
      oct.frequency.value = f * 2;
      oct.detune.value = detune / 2;
      const og = ctx.createGain();
      og.gain.value = 0.14;
      oct.connect(og).connect(vca);
      oct.start(t0);
      oct.stop(t0 + 3);
    }
  };
}

/**
 * String section expansion (string portfolio wave): cello/violin/pizzicato/
 * nylon/orchestra hit — the bowed and plucked orchestra the bank lacked.
 *
 * Cello — dark bowed low register: detuned saw pair through two body
 * resonances (250/400 Hz, the cello corpus), slow bow attack, sustained.
 * C2 anchor. */
function cello(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 65.41; // C2
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(0.9, t0 + 0.06);
    vca.gain.setValueAtTime(0.9, t0 + 2.0);
    vca.gain.linearRampToValueAtTime(0, t0 + 2.4);
    for (const [formant, q, level] of [
      [250, 3, 0.55],
      [400, 2.4, 0.4],
    ] as [number, number, number][]) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = formant;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      vca.connect(bp).connect(g).connect(dest);
    }
    for (const detune of [0, 5]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      osc.connect(vca);
      osc.start(t0);
      osc.stop(t0 + 2.5);
    }
  };
}

/** Violin — the singing bowed lead: saw pair with violin corpus formants
 * (300/450/2800 Hz), delayed vibrato (the bow settles before the hand
 * rocks), bright top. A4 anchor. */
function violin(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 440; // A4
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(0.8, t0 + 0.05);
    vca.gain.setValueAtTime(0.8, t0 + 1.7);
    vca.gain.linearRampToValueAtTime(0, t0 + 2.0);
    for (const [formant, q, level] of [
      [300, 2.5, 0.4],
      [450, 2, 0.35],
      [2800, 1.5, 0.18],
    ] as [number, number, number][]) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = formant;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      vca.connect(bp).connect(g).connect(dest);
    }
    const vibrato = ctx.createOscillator();
    vibrato.type = "sine";
    vibrato.frequency.value = 5.8;
    const vibGain = ctx.createGain();
    vibGain.gain.setValueAtTime(0, t0);
    vibGain.gain.linearRampToValueAtTime(8, t0 + 0.25);
    vibrato.connect(vibGain);
    vibrato.start(t0);
    vibrato.stop(t0 + 2.1);
    for (const detune of [0, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      vibGain.connect(osc.detune);
      osc.connect(vca);
      osc.start(t0);
      osc.stop(t0 + 2.1);
    }
  };
}

/** Pizzicato — the staccato string pluck: triangle partials with a fast
 * exponential decay, soft finger click, diffuse second voice for the
 * section feel. C4 anchor. */
function pizzicato(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 261.63; // C4
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 3600;
    lpf.connect(dest);
    for (const [ratio, level, decay] of [
      [1, 0.5, 0.22],
      [2, 0.2, 0.14],
      [3, 0.08, 0.09],
    ] as [number, number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f * ratio;
      osc.connect(env(ctx, t0, level, decay)).connect(lpf);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    }
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = f * 1.003;
    osc.connect(env(ctx, t0 + 0.012, 0.22, 0.18)).connect(lpf);
    osc.start(t0 + 0.012);
    osc.stop(t0 + 0.4);
    const click = noiseSource(ctx, 9, 0.012, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f * 3;
    click
      .connect(bp)
      .connect(env(ctx, t0, 0.12, 0.008))
      .connect(dest);
  };
}

/** Nylon guitar — the round classical voice: soft triangle partials (no
 * steel brightness), gentle thumb attack, warm top. Rounder than the steel
 * acousticGuitar. A2 anchor (nylon lives mid). */
function nylonGuitar(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 110; // A2
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.012);
    vca.gain.setTargetAtTime(0.0005, t0 + 0.08, 0.5);
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 2000;
    vca.connect(lpf).connect(dest);
    for (const [ratio, level] of [
      [1, 0.55],
      [2, 0.18],
      [3, 0.06],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(vca);
      osc.start(t0);
      osc.stop(t0 + 2.2);
    }
    const click = noiseSource(ctx, 14, 0.02, t0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1400;
    click
      .connect(bp)
      .connect(env(ctx, t0, 0.08, 0.015))
      .connect(dest);
  };
}

/** Orchestra hit — the classic stab: wide detuned saw stack (brass-ish
 * formant + string sheen) over a timpani thump. Short, punchy. C4. */
function orchestraHit(): Builder {
  return (ctx, dest) => {
    const t0 = ctx.currentTime;
    const f = 261.63; // C4
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(1, t0);
    vca.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.55);
    const brass = ctx.createBiquadFilter();
    brass.type = "bandpass";
    brass.frequency.value = 1100;
    brass.Q.value = 0.8;
    const brassG = ctx.createGain();
    brassG.gain.value = 0.5;
    vca.connect(brass).connect(brassG).connect(dest);
    const sheen = ctx.createBiquadFilter();
    sheen.type = "highpass";
    sheen.frequency.value = 2800;
    const sheenG = ctx.createGain();
    sheenG.gain.value = 0.2;
    vca.connect(sheen).connect(sheenG).connect(dest);
    for (const detune of [-12, -5, 0, 6, 12]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.detune.value = detune;
      osc.connect(vca);
      osc.start(t0);
      osc.stop(t0 + 0.6);
      const sub = ctx.createOscillator();
      sub.type = "sawtooth";
      sub.frequency.value = f / 2;
      sub.detune.value = detune;
      const sg = ctx.createGain();
      sg.gain.value = 0.4;
      sub.connect(sg).connect(vca);
      sub.start(t0);
      sub.stop(t0 + 0.6);
    }
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(140, t0);
    thump.frequency.exponentialRampToValueAtTime(55, t0 + 0.2);
    thump.connect(env(ctx, t0, 0.45, 0.25)).connect(dest);
    thump.start(t0);
    thump.stop(t0 + 0.4);
  };
}

/** Exported for the content-coherence tests (tests/kick-bank.test.ts). */
export const BUILDERS: Record<string, Builder> = {
  // Phase-3 re-voice (2026-10-04): kick.deep ↔ kick.lofi was 0.077* on
  // loud +0.051 (deep o 51ms dlhší, ale read-ešte blízko). Posunúť deep
  // hlbšie: decay 0.42 -> 0.50 (deep = *deepest* v celej bank, 0.5s telo)
  // a click 0.25 -> 0.20 (menej high-end = väčšia diferenciácia od lofi).
  // Pitch 46.25 Hz (F#1) je v glide contracte.
  "factory.kick.deep": kick(150, 46.25, 0.5, 0.2),
  // De-homog (2026-10-04 wave 2): kick.pop <-> kick.punch measured 0.096* on
  // air + loud (a punch click 0.6 at louder body still reads a pop twin).
  // punch commits DOWN (a longer, darker punch — decay 0.28 -> 0.34, click
  // 0.6 -> 0.4: the body IS the voice), pop owns the tight bright pocket.
  "factory.kick.punch": kick(210, 55.0, 0.34, 0.4),
  "factory.kick.techno": kick(175, 43.65, 0.55, 0.3, 0.7),
  "factory.kick.sub808": sub808(),
  // Kick trio de-dup (library-quality audit 2026-10-04, second pass): deep /
  // soft / trap measured d=0.005 against each other — the closest pair in the
  // whole library, both pairs sharing `deep` as the common member. Only the two
  // non-anchors move (deep stays the F#1 house/sub reference the genre kits
  // name), and they separate on the two features the redundancy metric reads
  // besides the spectrum: duration and click balance. Round-gentle becomes a
  // long, click-light boom; tight-pitch-drop becomes the short, hard-clicked,
  // harder-driven one whose drop is twice as wide (260 → 49 Hz in the same
  // 90 ms), which is what "Pitch-drop" promises. End frequencies are untouched,
  // so the bank-wide glide contract (F#1 deep / G1 trap / F1 soft) still holds.
  "factory.kick.trap": kick(260, 49.0, 0.24, 0.6, 0.6),
  "factory.kick.soft": kick(118, 43.65, 0.62, 0.08),
  // Kick bank expansion (2026-09): genre-anchored one-shots — the 808
  // family (drive/pure/drill), the vintage pair (phonk/lofi), and the
  // club/heritage punches (jersey/dnb/knock/909). Each targets a distinct
  // spectral+decay pocket so a beat can actually pick between them.
  // Glide rests sit on exact semitones bank-wide (audit 2026-09-29 snapped
  // the 808s; 2026-09-30 completed the remaining kicks): F1 soft/techno,
  // F#1 deep, G1 trap/phonk/lofi, G#1 dnb/909/pop, A1 punch/jersey/knock.
  "factory.kick.808drive": sub808Drive({
    startHz: 150,
    endHz: 36.71,
    dropSec: 0.5,
    tailSec: 0.12,
    tau: 0.32,
    drive: 0.55,
    lpfHz: 6000,
    click: 0.15,
  }),
  "factory.kick.808pure": sub808Drive({
    startHz: 140,
    endHz: 34.65,
    dropSec: 0.45,
    tailSec: 0.14,
    tau: 0.42,
    drive: 0,
    lpfHz: 4000,
    click: 0,
  }),
  // Drill kick re-voice (library-quality audit 2026-10-04): the shipped voice
  // held a static 41 Hz tone at full level for 600 ms (tail 0.1 s, tau 0.16 s)
  // through a 4× tape drive — 600 ms of clipped sub is 1.9 dB crest against a
  // 4.7–6.2 dB bank, i.e. the one Kick whose "Tight" contract (short, snappy,
  // growling) read as a sustained drone. The glide now snaps in 40 ms, the
  // body decays on a 75 ms constant (0.4 s file, bank-standard tail), and the
  // mid-forward drive is nudged up so the 808 still growls on small speakers.
  "factory.kick.drill": sub808Drive({
    startHz: 175,
    endHz: 41.2,
    dropSec: 0.04,
    tailSec: 0.05,
    tau: 0.075,
    drive: 0.5,
    lpfHz: 4500,
    click: 0.5,
  }),
  "factory.kick.phonk": vintageThump({
    startHz: 130,
    endHz: 49.0,
    decay: 0.3,
    drive: 0.5,
    lpfHz: 3200,
    gritHz: 1200,
    gritGain: 0.08,
    seed: 31,
  }),
  // jersey kick re-voice (de-dup wave): the jersey-club signature is the
  // HIGH bouncy pitch — B1, shortest body, hardest click of the trio.
  "factory.kick.jersey": kick(210, 61.74, 0.2, 0.7),
  // Phase-2/3 re-voice (2026-10-04): kick.dnb was 0.086* from kick.phonk
  // on brightness. Fáza 2 settled on decay 0.18 / click 0.75 which
  // pushed kick.dnb <-> kick.phonk to 0.172 (mimo watchlistu) but
  // introduced three new watchlist pairs in Phase 3:
  //   dnb <-> pop  0.126* (air +0.072, brightness -0.049)
  //   dnb <-> jersey 0.133* (brightness -0.077)
  //   dnb <-> phonk 0.172 (OK, mimo watchlistu)
  // Všetky tri nové majú dominujúcu os "brightness" / "high" — dnb je
  // príliš jasný. Kompromis: click 0.75 -> 0.6 (dostatočne nízko aby
  // dnb nebol pop-klon, dostatočne vysoko aby dnb ostáva >0.15 od
  // phonk). Decay 0.18 a pitch 51.91 Hz zostávajú.
  // Wave-2 (2026-10-04): dnb <-> pop 0.119* (air + loud after the punch
  // re-voice). The manifest identity is "Rolling, Punchy" — decay 0.18 was
  // the pop pocket, not a roll. decay 0.18 -> 0.26, click 0.6 -> 0.5: the
  // dnb kick ROLLS (longer body, softer tick; the break's bass carries the
  // punch), pop stays the tight bright club voice. Pitch 51.91 Hz stays
  // (glide contract). Phonk stays >0.15 (decay gap widens it further).
  "factory.kick.dnb": kick(170, 51.91, 0.26, 0.5),
  // Phase-2 re-voice: kick.lofi had a 0.084* distance to kick.knock driven
  // by crest (+0.045) + loud (+0.042) — knock is a louder, harder knocker.
  // Iterated four configurations and locked pass 2 as the right balance:
  //   pass 0 (decay 0.3 / drive 0.25 / LPF 2600)  -> 0.084* (původní)
  //   pass 1 (decay 0.36 / drive 0.4 / LPF 2600)   -> 0.073* (drive 0.4  ≡ knock crest)
  //   pass 2 (decay 0.36 / drive 0.32 / LPF 2200) -> 0.067* (LOCKED — smallest d,
  //                                                    no new pairs introduced)
  //   pass 3 (decay 0.36 / drive 0.5 / LPF 2200)  -> 0.088* (but spawned two new
  //                                                    pairs: lofi↔phonk 0.110 and
  //                                                    lofi↔deep 0.120 — drive 0.5
  //                                                    squared lofi's body into a
  //                                                    phonk-like attack envelope)
  // Pass 2 widens the body (0.3 -> 0.36, loudMs 360 -> 417), deepens the LPF
  // (2600 -> 2200) and adds a moderate tape bump (drive 0.25 -> 0.32) — all
  // three moves widen different axes of the lofi/knock pair without the
  // pass-3 side effect of pushing lofi toward the 808 family.
  // Wave-2 add (2026-10-04): the pair re-opened at 0.066* with the attack
  // axis live; the tape grit is the voice lofi has and knock lacks — raise
  // it (gritGain 0.1 -> 0.2, gritHz 900 -> 700) so the dusty read is audible
  // instead of decoration.
  "factory.kick.lofi": vintageThump({
    startHz: 115,
    endHz: 49.0,
    decay: 0.36,
    drive: 0.32,
    lpfHz: 2200,
    gritHz: 700,
    gritGain: 0.2,
    seed: 37,
  }),
  "factory.kick.knock": knock(),
  // Phase-3 re-voice (2026-10-04): kick.909 ↔ kick.trap was 0.093* on
  // air -0.059 / loud +0.051 — trap (drive 0.6) bol squarovaný jasnejšie,
  // 909 (drive 0.15) mal menej high. Zvýšiť 909 start frekvenciu
  // 290 -> 310 Hz (B1+ vyššie, jasnejšie) — endHz 51.91 Hz zostáva
  // (glide contract). Decay/click/drive 0.15/0.6 bezo zmeny.
  // De-homog (2026-10-04 wave 2): 909 <-> trap opened to 0.114* on air +
  // loud after the punch/trap de-homog. Drive 0.15 -> 0.28 gave the 909 its
  // own snappy overdrive; wave-2 b extends the HERITAGE body (0.3 -> 0.38:
  // a real TR-909 kick rings past 300 ms) so the pair separates on loud
  // (909 longer) + attack (trap's wide-drop click reads harder), trap stays
  // the short bright genre voice.
  "factory.kick.909": kick(310, 51.91, 0.38, 0.6, 0.28),
  "factory.rim.chip": rim(),
  "factory.rim.hard": rimHard(),
  "factory.rim.snap": rimSnap(),
  "factory.snare.main": snare(192, 0.11, 0.2, 1750),
  // De-homog (2026-10-04 wave 2): snare.dnb <-> snare.tight measured 0.101*
  // on brightness + sub — the two dark-ish short snares. dnb is the genre-
  // locked backbeat (170 BPM break), so tight moves: its 2000 Hz noise band
  // brightens to 2400 Hz (snare.main keeps 1750, dnb 2500 above it — tight
  // becomes the cracky bright ghost voice, not the dark middle child).
  // Wave-2 b: jersey went to 2800 (brighter than tight 2400 by only 400 Hz
  // — same crack band, same read). Wave-2 c: tight down to 1900 collided
  // with drill (0.058* — both short dark ~2 kHz). The ghost's real voice is
  // THIN-HIGH, not dark: tone 210 -> 246 (B3 — the piccolo-ghost read) with
  // noiseHz 2200 (between main 1750 and dnb 2500), toneDecay 0.05 (shortest
  // body in the bank). Four distinct pockets: main 1750 room backbeat /
  // tight 2200 thin-high ghost / dnb 2500 genre / jersey 2800 club crack.
  // Load-bearing FACTORY_SNARE_DYNAMIC ghost (velocity < 0.35) — decay/
  // level stay close to the shipped read.
  "factory.snare.tight": snare(246, 0.05, 0.1, 2200),
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
  // De-homog (2026-10-04 wave 2): jersey is the club-crack ghost — push its
  // band UP (2400 -> 2800, click 0.7 -> 0.8): above tight's 2400 now AND
  // above dnb's 2500, so the three snareCrack bands read main 1750 (room
  // backbeat) / tight 2400 (bright ghost) / dnb 2500 dark tail (genre) /
  // jersey 2800 (club crack), instead of tight+jersey sharing one band.
  "factory.snare.jersey": snareCrack({
    toneHz: 240,
    toneDecay: 0.06,
    noiseHz: 2800,
    noiseDecay: 0.11,
    click: 0.8,
    seed: 47,
  }),
  // Phase-2 re-voice (2026-10-04): snare.dnb was the only snareCrack family
  // member sitting under snare.main on every single axis (brightness -0.093,
  // loud -0.037, air -0.036, crest -0.035, high -0.027). The shipped numbers
  // produced a dnb backbeat that read like a darker snare.main — a 0.123*
  // watchlist pair with no perceptual reason to be that close. Tighten the
  // body and brighten the band: noiseDecay 0.19 -> 0.12 (shorter, dnb
  // backbeats don't smear), noiseHz 1900 -> 2500 (above snare.main's 1750
  // band), click 0.3 -> 0.6 (the dnb backbeat has to cut through 170 BPM
  // breaks), toneDecay 0.11 -> 0.08 (matching the crack family's 60-80 ms
  // body). toneHz 210 preserved (the dnb fundamental).
  "factory.snare.dnb": snareCrack({
    toneHz: 210,
    toneDecay: 0.08,
    noiseHz: 2500,
    noiseDecay: 0.12,
    click: 0.6,
    seed: 53,
  }),
  "factory.snare.lofi": snareDusty({ toneHz: 172, toneDecay: 0.1, noiseHz: 1300, noiseDecay: 0.17, seed: 59 }),
  // Room snare (library-gap wave): the house/boom-bap backbeat with walls —
  // dry crack + early reflections + dark diffuse tail (the only snare with
  // air behind it; every other bank snare is dry/short).
  "factory.snare.room": snareRoom(),
  "factory.hat.drill": hat(0.035, 9200, 0.5),
  // De-homog (2026-10-04 wave 2): hat.pedal <-> hat.phonk sat at 0.081* on
  // sub + low — two dark hats reading each other's filter junk (a 4-5 kHz HPF
  // hat has no real sub; its sub share is analyzer floor). Same lesson the
  // attack term's participation floor taught: COMMIT the split. pedal (the
  // foot-splash) drops to 4000 Hz / 25 ms — the dry tick; phonk goes darker
  // AND gains a metallic ping (3400 Hz wash under a 4800 Hz ping, decay 70
  // ms) — the dusty hat. Ping register separates them from the rest of the
  // hat family too (jersey 6400 / dnb 7100). First attempt at a plain
  // hat(0.07, 3400, 0.4) left them at 0.071* (both became featureless dark
  // noise) — the ping is what makes phonk a HAT instead of a dark wash.
  "factory.hat.phonk": hatMetallic({ decay: 0.07, hpHz: 3400, level: 0.36, pingHz: 4800, ping: 0.22, seed: 43 }),
  "factory.hat.jersey": hatMetallic({ decay: 0.055, hpHz: 8200, level: 0.55, pingHz: 6400, ping: 0.3, seed: 61 }),
  "factory.hat.dnb": hatMetallic({ decay: 0.04, hpHz: 9600, level: 0.5, pingHz: 7100, ping: 0.24, seed: 67 }),
  // cup re-voice (2026-09-30): at the shipped 5200 Hz / 95 ms ring it was a
  // near-twin of hat.open (d=0.102); a first push to 4600 Hz barely moved it
  // (d=0.066 — the decay barely changed). The dark side has to be COMMITTED:
  // 3800 Hz ring (half an octave below open), 0.5 s dark wash under a loud
  // 4300 Hz ping — open keeps the bright sizzle, cup owns the dark cup voice.
  "factory.hat.open.cup": hatMetallic({ decay: 0.5, hpHz: 3800, level: 0.42, pingHz: 4300, ping: 0.3, seed: 71 }),
  // Hat wash (library-gap wave): the long offbeat bloom — pings + darkening
  // noise wash (the only bank hat past 100 ms decay).
  "factory.hat.wash": hatWash(),
  "factory.clap.main": clap(),
  "factory.clap.soft": clapSoft(),
  "factory.clap.dnb": clapDnb(),
  "factory.clap.trad": clapTrad(),
  "factory.shaker.soft": shaker(),
  // Phase-3 re-voice (2026-10-04): hat.closed ↔ hat.closed.soft was 0.094*
  // on lowmid +0.050 + crest +0.040 + himid +0.037 + sub +0.034 — soft
  // mal viac low-end (HPF 6400 nechá telo) a vyšší crest. Znížiť closed
  // level 0.55 -> 0.48 (tichší closed) — zatvorí sa loud gap a zníži
  // sa celkový crest gap (RMS ide nadol, peak ostáva). Decay 0.055 +
  // HPF 7400 zostávajú.
  "factory.hat.closed": hat(0.055, 7400, 0.48),
  // Phase-2 re-voice (2026-10-04): hat.closed.soft was 0.121* from hat.pedal
  // with low -0.073 + crest +0.060 (low-band spread — a pedal-hat should be
  // the darkest/shortest, a closed-soft should be the brightest/thinnest).
  // Three passes:
  //   pass 1 (HPF 6200 / level 0.30)  -> 0.115* — himid gap -0.046
  //   pass 2 (HPF 6000 / level 0.34)  -> 0.116* — himid gap -0.039
  //   pass 3 (HPF 5800 / level 0.34)  -> 0.122* — low spread returned
  //   pass 4 (HPF 6400 / level 0.28)  -> 0.115* — same crest, less body
  //   pass 5 (HPF 6400 / level 0.28) is the right compromise: the HPF keeps
  //   the soft voice above the pedal band, the lower level reduces crest
  //   (the head of the snareOne noise sits closer to the mean). The pair
  //   still sits on the watchlist but the dominant axes are now crest
  //   (loudness) and brightness (intended), not low-band spread.
  "factory.hat.closed.soft": hat(0.04, 6400, 0.4),
  "factory.hat.open": hat(0.36, 7000, 0.5),
  "factory.hat.open.short": hat(0.18, 6800, 0.42),
  // De-homog (2026-10-04 wave 2): pedal is the foot-splash — the dry, SHORT
  // tick under a foot. 0.035 -> 0.025 decay, HPF 4600 -> 4000 (a hair below
  // phonk's 3400 wash but well below the 6400-9600 closed/open family) so
  // the pedal↔phonk pair separates on decay + register instead of on the
  // sub/low filter junk both used to share.
  "factory.hat.pedal": hat(0.025, 4000, 0.24),
  "factory.ride.ping": ride(),
  "factory.ride.bell": rideBell(),
  "factory.ride.splash": rideSplash(),
  "factory.crash.main": crash(8200, 1.3, 0.6),
  "factory.crash.dark": crash(5200, 1.7, 0.5),
  "factory.crash.short": crashShort(),
  "factory.crash.trash": crashTrash(),
  "factory.tom.low": tom(150, 92),
  "factory.tom.mid": tom(185, 120),
  "factory.tom.high": tom(220, 150),
  "factory.tom.perc": tomPerc(),
  "factory.perc.tick": tick(),
  "factory.perc.blip": blip(880, 620, 0.09),
  "factory.perc.cowbell": cowbell(),
  // Phonk/oriental pack (quality backlog): cowbell variety + sitar/erhu.
  "factory.perc.cowbell.dark": cowbellDark(),
  "factory.perc.cowbell.scream": cowbellScream(),
  "factory.perc.cowbell.drill": cowbellDrill(),
  "factory.perc.cowbell.bright": cowbellBright(),
  "factory.tonal.sitar": sitar(),
  "factory.tonal.erhu": erhu(),
  "factory.perc.conga": conga(),
  "factory.perc.tambourine": tambourine(),
  // Percussion flavor pack (percussion pack wave)
  "factory.perc.woodblock": woodblock(),
  "factory.perc.clave": clave(),
  "factory.perc.snapstack": snapstack(),
  "factory.shaker.long": shakerLong(),
  "factory.fx.riser": fxRiser(),
  "factory.fx.downlifter": fxDownlifter(),
  "factory.fx.impact": fxImpact(),
  "factory.fx.sweep": fxSweep(),
  "factory.fx.reverse": fxReverse(),
  "factory.fx.noise": fxNoise(),
  // Transition pack (transition pack wave): quick-transition siblings
  "factory.fx.impact2": fxImpact2(),
  "factory.fx.riser-short": fxRiserShort(),
  "factory.fx.noise-down": fxNoiseDown(),
  // Sub-drop (library-gap wave): the drill/trap transition staple — a two-
  // octave pitch fall landing on a semitone-clean C1.
  "factory.fx.subdrop": fxSubDrop(),
  // Vinyl crackle (library-gap wave): the dusty texture bed under lo-fi and
  // phonk beats — flat/stationary so it loops, mid/treble so it never fights
  // the 808.
  "factory.fx.vinyl": fxVinyl(),
  "factory.tonal.pluck": pluck(),
  "factory.tonal.stab": stab(),
  "factory.tonal.keys": keys(),
  "factory.tonal.bell": bell(),
  // Mallet pack (quality backlog): the struck-bar family the bank lacked.
  "factory.mallet.vibes": mallet({
    fundamental: 262, // C4
    partials: [
      [1, 0.5],
      [4, 0.22],
      [9.2, 0.06],
    ],
    decay: 2.6,
    attack: 0.005,
    // Softest contact of the family (rubber mallets on metal): its strike peak
    // lands ~5 dB under the bar's own peak — a chime, not a knock. Strike
    // levels across the family are calibrated per voice so each contact LEADS
    // its own band envelope (see the strike-fix note in mallet()), not ranked.
    clickLevel: 1.5,
    clickHz: 2600,
    clickQ: 0.9,
    tremoloHz: 5.2,
    tremoloDepth: 0.55,
  }),
  // Marimba re-voice (library-quality audit 2026-10-04): the C3 anchor put the
  // default mallet strike (4 × 131 = 524 Hz) inside the bar's own 2nd partial,
  // so the voice had no usable attack content above 2 kHz (2–6 kHz sat 40 dB
  // under its four sibling mallets) and its 1 ms envelope was flat-topped — a
  // "Wooden, Punchy" voice that read as a pad. Two changes carry the fix: the
  // knock sits at a real wood-contact frequency with a broad (Q 0.8) band, and
  // the resonator's 2nd/3rd partials carry more of the bar — the tape stage
  // squares them into the 2–6 kHz region (+5.7 dB) that a 131 Hz bar cannot reach.
  // The strike itself is the strongest of the family (rosewood on a low rosewood
  // bar) and is now actually rendered — the "inert strike" this voice was
  // diagnosed with turned out to be 14 dB of band-pass loss on the strike path,
  // fixed in mallet().
  "factory.mallet.marimba": mallet({
    fundamental: 131, // C3 — marimba lives an octave below the vibes
    partials: [
      [1, 0.6],
      [4, 0.24],
      [10, 0.06],
    ],
    decay: 0.9,
    attack: 0.002,
    // Hardest contact of the family (rosewood on a low rosewood bar): strike
    // peak level with the bar's — the "punchy" half of "Wooden, Punchy".
    clickLevel: 2.0,
    clickHz: 2400,
    clickQ: 0.8,
    lpfHz: 6500,
  }),
  // Celesta re-voice (sound-library audit 2026-10): it shipped with the exact
  // music-box 1:3:6 partial table (only the decay differed) — the two files
  // measured 0.999 waveform-correlated, one voice sold twice. A real celesta
  // is the soft, pure bell: near-inharmonic bright partials (1 : 2.76 : 5.4)
  // an octave up from the music box, with a gentler strike and no 3× sparkle.
  "factory.mallet.celesta": mallet({
    fundamental: 1046.5, // C6 — celesta reads an octave above the keyboard
    partials: [
      [1, 0.5],
      [2.76, 0.16],
      [5.4, 0.05],
    ],
    decay: 1.6,
    attack: 0.002,
    // Felt hammer on a small steel bar: the gentlest contact of the family — a
    // click you hear once, never a knock (its body already fills the contact
    // band, hence the higher raw level; the shipped 0.12 measured 20 dB under
    // the bar's own attack ramp — see the strike-fix note in mallet()).
    clickLevel: 1.6,
    clickHz: 3400,
    clickQ: 1.3,
    lpfHz: 9000,
  }),
  "factory.tonal.wurli": wurli(),

  // Lead expand wave (Priority 1, UN-SUNO lead-lane feed): the mono lead
  // voices the bank never had. The sampler's default was a tonal pluck —
  // every UN-SUNO lead sounded like the same pluck. Now the lead lane has
  // a real palette: workhorse saw, anthem supersaw, chiptune square, and
  // two filter plucks (bright trance / dark prog).
  "factory.lead.saw": leadSaw(),
  "factory.lead.supersaw": leadSupersaw(),
  "factory.lead.square": leadSquare(),
  "factory.lead.pluck.bright": leadPluck(true),
  "factory.lead.pluck.dark": leadPluck(false),
  "factory.tonal.organ": organ(),
  "factory.tonal.acousticguitar": acousticGuitar(),
  "factory.tonal.choirpad": choirPad(),
  "factory.tonal.cello": cello(),
  "factory.tonal.violin": violin(),
  "factory.tonal.pizzicato": pizzicato(),
  "factory.tonal.nylonguitar": nylonGuitar(),
  "factory.tonal.orchestrahit": orchestraHit(),

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

  // Bass pack (library-completion wave 2026-10-04): the empty category,
  // filled with five designed pockets — pure sub, reese, FM bell-bass, pluck,
  // LFO wobble and saturated dist. Root D2 on every voice.
  "factory.bass.clean": bassClean(),
  "factory.bass.reese": bassReese(),
  "factory.bass.fm": bassFM(),
  "factory.bass.pluck": bassPluck(),
  "factory.bass.wobble": bassWobble(),
  "factory.bass.dist": bassDist(),

  // Bass expand wave (Priority 1, UN-SUNO bass-lane feed): the melodic 808
  // as velocity zones, held subs, the upright jazz voice, and the acid
  // squelch at two rates — every one a pocket the six originals leave open.
  "factory.bass.808.soft": bass808("soft"),
  "factory.bass.808.medium": bass808("medium"),
  "factory.bass.808.hard": bass808("hard"),
  "factory.bass.subsine": bassSubSine(),
  "factory.bass.subsquare": bassSubSquare(),
  "factory.bass.upright": bassUpright(),
  "factory.bass.acid.fast": bassAcid("fast"),
  "factory.bass.acid.slow": bassAcid("slow"),

  // Pop wave (vocal-first + thin-spot fill): tight pop kick, stacked pop
  // clap, bright crash, floor tom, clicky rim, driving shaker, kalimba and
  // music-box mallets. Each targets a distinct spectral/decay pocket.
  // pop kick re-voice (de-dup wave): punch stayed the neutral G#1 stock, so
  // pop moves to A1 with a TIGHT body + bright click — the pop/dance voice
  // (jersey sits above it at B1 as the club bounce). Same family, three
  // distinct roles: full-punch / tight-pop / high-bounce. Wave-2 (2026-10-04):
  // dnb owns the roll (0.26 body), so pop commits to the TIGHTEST: 0.22 ->
  // 0.18 + click 0.6 -> 0.7 (the two-fist pop punch read).
  "factory.kick.pop": kick(195, 55.0, 0.18, 0.7),
  // clap.pop re-voice (2026-09-30): was clap.main + clap.soft stacked
  // verbatim — after mastering normalized both to −10.5 the stack collapsed
  // onto main (feature distance 0.051). Now its own dense bright stack.
  "factory.clap.pop": clapPopStack(),
  // crash.pop re-voice (2026-09-30): was the crash.main recipe on a lower
  // band (feature distance 0.025 — a duplicate). Now the short bright splash
  // the manifest always claimed.
  "factory.crash.pop": crashPopSplash(),
  "factory.tom.floor": tom(130, 75),
  "factory.rim.pop": rimPop(),
  "factory.perc.shaker.pop": shakerPop(),
  "factory.mallet.kalimba": mallet({
    fundamental: 523.25, // C5 — kalimba sits above the keyboard
    partials: [
      [1, 0.55],
      [4, 0.15],
    ],
    decay: 0.7,
    attack: 0.002,
    // Thumb on a metal tine: bright and immediate, and the only contact of the
    // family whose own bar rings inside the contact band (4th partial), so it
    // needs the most strike to lead.
    clickLevel: 2.9,
    clickHz: 2100,
    clickQ: 1.0,
    lpfHz: 7000,
  }),
  "factory.mallet.musicbox": mallet({
    fundamental: 1046.5, // C6 — music-box register
    partials: [
      [1, 0.5],
      [3, 0.22],
      [6, 0.08],
    ],
    decay: 2.0,
    attack: 0.002,
    // Plucked comb tooth: the brightest, narrowest contact of the family (a
    // pluck, not a hammer) — the same register as the celesta, kept apart by
    // timbre in both the bar (inharmonic 1:3:6 comb vs pure bell) and the
    // contact itself (5.2 kHz Q 2.6 vs 3.4 kHz Q 1.3).
    clickLevel: 2.0,
    clickHz: 5200,
    clickQ: 2.6,
  }),
};

/** Render length per asset, seconds — exported for coherence tests. */
export const DURATIONS: Record<string, number> = {
  "factory.kick.deep": 0.5,
  "factory.kick.punch": 0.35,
  "factory.kick.techno": 0.65,
  "factory.kick.sub808": 1.2,
  "factory.kick.trap": 0.45,
  "factory.kick.soft": 0.8,
  "factory.kick.808drive": 1.3,
  "factory.kick.808pure": 1.5,
  "factory.kick.drill": 0.6,
  "factory.kick.phonk": 0.55,
  "factory.kick.jersey": 0.4,
  "factory.kick.dnb": 0.42,
  "factory.kick.lofi": 0.5,
  "factory.kick.knock": 0.5,
  "factory.kick.909": 0.5,
  "factory.rim.chip": 0.08,
  "factory.rim.hard": 0.08,
  "factory.rim.snap": 0.04,
  "factory.snare.main": 0.3,
  "factory.snare.tight": 0.2,
  "factory.snare.punch": 0.32,
  "factory.snare.trap": 0.22,
  "factory.snare.drill": 0.2,
  "factory.snare.phonk": 0.32,
  "factory.snare.jersey": 0.18,
  "factory.snare.dnb": 0.28,
  "factory.snare.lofi": 0.3,
  "factory.snare.room": 0.7,
  "factory.hat.drill": 0.1,
  "factory.hat.phonk": 0.12,
  "factory.hat.jersey": 0.12,
  "factory.hat.dnb": 0.1,
  "factory.hat.open.cup": 0.6,
  "factory.hat.wash": 0.9,
  "factory.clap.main": 0.3,
  "factory.clap.soft": 0.36,
  "factory.clap.dnb": 0.4,
  "factory.clap.trad": 0.32,
  "factory.shaker.soft": 0.2,
  "factory.hat.closed": 0.12,
  "factory.hat.closed.soft": 0.1,
  "factory.hat.open": 0.45,
  "factory.hat.open.short": 0.26,
  "factory.hat.pedal": 0.08,
  "factory.ride.ping": 0.8,
  "factory.ride.bell": 1.3,
  "factory.ride.splash": 0.5,
  "factory.crash.main": 1.7,
  "factory.crash.dark": 1.9,
  "factory.crash.short": 0.5,
  "factory.crash.trash": 0.4,
  "factory.tom.low": 0.45,
  "factory.tom.mid": 0.45,
  "factory.tom.high": 0.45,
  "factory.tom.perc": 0.2,
  "factory.perc.tick": 0.05,
  "factory.perc.blip": 0.15,
  "factory.perc.cowbell": 0.36,
  "factory.perc.cowbell.dark": 0.5,
  "factory.perc.cowbell.scream": 0.55,
  "factory.perc.cowbell.drill": 0.25,
  "factory.perc.cowbell.bright": 0.3,
  "factory.tonal.sitar": 2.1,
  "factory.tonal.erhu": 1.9,
  "factory.perc.conga": 0.32,
  "factory.perc.tambourine": 0.3,
  "factory.perc.woodblock": 0.3,
  "factory.perc.clave": 0.3,
  "factory.perc.snapstack": 0.3,
  "factory.shaker.long": 0.6,
  "factory.fx.riser": 2.0,
  "factory.fx.downlifter": 2.0,
  "factory.fx.impact": 1.1,
  "factory.fx.sweep": 1.5,
  "factory.fx.reverse": 1.25,
  "factory.fx.noise": 0.35,
  "factory.fx.impact2": 0.9,
  "factory.fx.riser-short": 0.85,
  "factory.fx.noise-down": 0.95,
  "factory.fx.subdrop": 1.5,
  "factory.fx.vinyl": 4.0,
  "factory.tonal.pluck": 0.5,
  "factory.tonal.stab": 0.5,
  "factory.tonal.keys": 1.1,
  "factory.tonal.bell": 1.5,
  "factory.mallet.vibes": 3.2,
  "factory.mallet.marimba": 1.2,
  "factory.mallet.celesta": 1.9,
  "factory.tonal.wurli": 2.2,
  "factory.tonal.organ": 2.1,
  "factory.tonal.acousticguitar": 2.4,
  "factory.tonal.choirpad": 3.1,
  "factory.tonal.cello": 2.6,
  "factory.tonal.violin": 2.2,
  "factory.tonal.pizzicato": 0.45,
  "factory.tonal.nylonguitar": 2.3,
  "factory.tonal.orchestrahit": 0.7,
  "factory.tonal.memphisguitar": 1.4,
  "factory.tonal.darkstrings": 2.2,
  "factory.tonal.rhodes": 1.8,
  "factory.tonal.trumpet": 1.3,
  "factory.tonal.animepluck": 0.5,
  "factory.tonal.sadpiano": 2.2,
  "factory.tonal.padwarm": 2.8,
  "factory.tonal.harp": 1.4,
  "factory.kick.pop": 0.35,
  "factory.clap.pop": 0.35,
  "factory.crash.pop": 1.1,
  "factory.tom.floor": 0.45,
  "factory.rim.pop": 0.08,
  "factory.perc.shaker.pop": 0.2,
  "factory.mallet.kalimba": 1.0,
  "factory.mallet.musicbox": 2.2,
  "factory.bass.clean": 1.4,
  "factory.bass.reese": 1.8,
  "factory.bass.fm": 1.6,
  "factory.bass.pluck": 0.5,
  "factory.bass.wobble": 1.8,
  "factory.bass.dist": 1.5,
  "factory.bass.808.soft": 1.2,
  "factory.bass.808.medium": 1.5,
  "factory.bass.808.hard": 1.8,
  "factory.bass.subsine": 1.8,
  "factory.bass.subsquare": 1.8,
  "factory.bass.upright": 1.0,
  "factory.bass.acid.fast": 0.6,
  "factory.bass.acid.slow": 1.1,
  "factory.lead.saw": 1.1,
  "factory.lead.supersaw": 1.4,
  "factory.lead.square": 0.9,
  "factory.lead.pluck.bright": 0.9,
  "factory.lead.pluck.dark": 0.9,
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
  // Genre character drums (wave: pad round-robin) — each genre kit's own
  // snare/hat/kick gets a variation pool so the swapped kit varies like the
  // stock one instead of reverting to a machine-gun single sample.
  "factory.snare.phonk": [
    { rate: 1.011, gain: 1.04 },
    { rate: 0.99, gain: 0.95 },
  ],
  "factory.hat.phonk": [
    { rate: 1.02, gain: 1.04 },
    { rate: 0.982, gain: 0.95 },
  ],
  "factory.snare.jersey": [
    { rate: 1.013, gain: 1.04 },
    { rate: 0.989, gain: 0.95 },
  ],
  "factory.hat.drill": [
    { rate: 1.021, gain: 1.04 },
    { rate: 0.981, gain: 0.95 },
  ],
  "factory.kick.phonk": [
    { rate: 1.01, gain: 1.03 },
    { rate: 0.991, gain: 0.96 },
  ],
  // Room snare: a backbeat voice, so it varies like the other backbeat snares.
  "factory.snare.room": [
    { rate: 1.011, gain: 1.03 },
    { rate: 0.99, gain: 0.96 },
  ],
  // Hat wash: the offbeat mask repeats every 2 steps in 4/4 — same
  // machine-gun exposure as the other groove hats.
  "factory.hat.wash": [
    { rate: 1.016, gain: 1.04 },
    { rate: 0.986, gain: 0.95 },
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

/**
 * (Re)derive the round-robin variants for one base id from whatever buffer the
 * bank CURRENTLY holds.
 *
 * Called at bank build and again whenever the curated layer overrides a base.
 * Without the second call the base would be the mastered curated WAV while its
 * variants were derived from the synth fallback — two different drums
 * alternating, not one drum with micro-variation. Idempotent and a no-op for
 * ids that have no variation map or whose base is absent.
 */
export function applyRoundRobinVariants(bank: SampleBank, baseId: string): void {
  const variations = RR_VARIATIONS[baseId];
  if (!variations) return;
  const base = bank.get(baseId);
  if (!base) return;
  variations.forEach(({ rate, gain }, i) => {
    bank.add(`${baseId}.rr${i + 2}`, deriveVariation(base, rate, gain));
  });
}

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
  for (const baseId of Object.keys(RR_VARIATIONS)) {
    const base = bank.get(baseId);
    if (!base) throw new Error(`No base buffer for RR variation of ${baseId}`);
    applyRoundRobinVariants(bank, baseId);
  }
  return bank;
}
