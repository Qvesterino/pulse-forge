/**
 * Granular voice engine — per-sample grain scheduler in ONE AudioWorklet.
 *
 * Phase-2 voice-engine track (sibling of `wtvoice-processor`): the whole
 * granular voice (grain spawning, read head, trapezoid envelopes, stereo
 * pan, amp envelope, voice stealing) is computed sample-accurately here
 * instead of as an upfront-scheduled main-thread buffer-source cloud.
 *
 * What per-sample scheduling unlocks (impossible on the main thread):
 *  - a LIVE PLAYHEAD — POSITION / SCAN / JITTER / RATE / SIZE read at every
 *    grain spawn, so dragging them mid-note steers the cloud in real time
 *    (Granulator-II style). The main-thread fallback captures params at
 *    noteOn and can only apply changes to future notes.
 *  - SCAN drift integrated per grain with wrap, no precomputed sources.
 *
 * Determinism contract: no Math.random anywhere. Grain randomness comes from
 * a per-note mulberry32 PRNG seeded by the bridge from `hashString(trackId:
 * pitch)` — the same draw order as the fallback cloud (offset/reverse/pan/
 * pRand) — so the identical message sequence produces identical samples and
 * offline renders match live playback.
 *
 * Messaging (node.port, main thread -> worklet):
 *  {type:"sample", ch0:Float32Array, ch1:Float32Array|null, length, sampleRate}
 *  {type:"noteOn", pitch, velocity, when, seed}   absolute ctx time
 *  {type:"noteOff", pitch, when}
 *  {type:"panic"}
 *  {type:"param", name, value}                    k-rate, immediate
 *  {type:"bpm", value}
 */

const VOICES_MAX = 6;
const GRAINS_PER_NOTE_MAX = 512;
const GRAINS_ACTIVE_MAX = 48; // concurrent per voice — rate 60/s × 0.4 s ≈ 24
const SYNC_BEATS = [0, 2, 1, 0.75, 0.5, 1 / 3, 0.25]; // OFF, 1/2, 1/4, 1/8D, 1/8, 1/8T, 1/16

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Grain {
  constructor() {
    this.active = false;
    this.pos = 0; // float read index into the sample
    this.rate = 1; // sample-advance per output sample (signed — reverse reads back)
    this.remaining = 0; // samples left in the grain
    this.ramp = 0;
    this.plateau = 0;
    this.age = 0;
    this.peak = 0;
    this.panL = 0.7071;
    this.panR = 0.7071;
    this.ch = 0; // source channel count
  }
}

class GrainVoice {
  constructor(index, params) {
    this.index = index;
    this.p = params;
    this.bpm = 120;
    this.active = false;
    this.gate = false;
    this.dead = true;
    this.pitch = 60;
    this.vel = 0;
    this.age = 0;
    this.startFrame = 0;
    this.offFrame = 0;
    this.env = 0;
    this.stage = "attack";
    this.peak = 0;
    this.rand = () => 0;
    this.spawned = 0;
    this.nextSpawn = 0; // absolute sample frame of the next grain
    this.grains = [];
    for (let i = 0; i < GRAINS_ACTIVE_MAX; i++) this.grains.push(new Grain());
  }

  noteOn(msg, sr) {
    this.active = true;
    this.gate = true;
    this.dead = false;
    this.pitch = msg.pitch;
    this.vel = Math.max(0, Math.min(1, msg.velocity));
    this.startFrame = Math.round(msg.when * sr);
    const size = Math.min(0.4, Math.max(0.02, this.p.size ?? 0.09));
    const hold = Math.max(msg.dur ?? 0.5, size + 0.02);
    this.offFrame = this.startFrame + Math.round(hold * sr);
    this.env = 0;
    this.stage = "attack";
    this.peak = this.vel * (this.p.gain ?? 0.8);
    this.spawned = 0;
    this.rand = mulberry32(msg.seed >>> 0);
    this.nextSpawn = this.startFrame;
    for (const g of this.grains) g.active = false;
  }

  release(nowFrame, sr) {
    this.gate = false;
    this.offFrame = Math.min(this.offFrame, nowFrame);
    this.stage = "release";
    void sr;
  }

  /** Effective grains/s — R SYNC lock resolved at spawn time (live BPM). */
  grainRate(sr) {
    const beats = SYNC_BEATS[Math.max(0, Math.min(SYNC_BEATS.length - 1, Math.round(this.p.rateSync ?? 0)))];
    const hz = beats > 0 && this.bpm > 0 ? (this.bpm / 60) * beats : (this.p.rate ?? 14);
    return Math.max(0, Math.min(60, hz));
  }

  spawn(frame, sr, sample) {
    if (!sample || sample.length === 0) return;
    if (this.spawned >= GRAINS_PER_NOTE_MAX) return;
    if (frame >= this.offFrame + 0.005 * sr) return;
    const free = this.grains.find((g) => !g.active);
    if (!free) return;

    const p = this.p;
    const position = Math.min(1, Math.max(0, p.position ?? 0.25));
    const size = Math.min(0.4, Math.max(0.02, p.size ?? 0.09));
    const jitter = Math.max(0, p.jitter ?? 0.15);
    const spread = Math.max(0, Math.min(1, p.spread ?? 0.5));
    const reverseProb = Math.min(1, Math.max(0, p.reverse ?? 0));
    const shape = Math.min(1, Math.max(0, p.shape ?? 0.5));
    const scan = Math.max(-2, Math.min(2, p.scan ?? 0));
    const pitchRand = Math.max(0, Math.min(12, p.pRand ?? 0));

    // Same PRNG draw order as the fallback cloud: offset, reverse, pan,
    // then pRand — legacy pRand-free seeds stay stream-identical.
    const tSec = (frame - this.startFrame) / sr;
    const drift = position + scan * tSec;
    const basePos = scan !== 0 ? drift - Math.floor(drift) : position;
    const offsetFrac = Math.min(0.999, Math.max(0, basePos + (this.rand() * 2 - 1) * jitter * 0.5));
    const reverse = this.rand() < reverseProb;
    const pan = (this.rand() * 2 - 1) * spread;
    const playRate = Math.pow(2, (this.pitch - 60 + (p.pitch ?? 0)) / 12);
    const grainRate = Math.max(
      0.02,
      playRate * (pitchRand > 0.005 ? Math.pow(2, ((this.rand() * 2 - 1) * pitchRand) / 12) : 1),
    );

    const len = sample.length;
    const grainDurSamples = Math.round((size + 0.01) * sr);
    let start = offsetFrac * len;
    // Clamp so the grain window stays inside the sample (fallback semantics).
    const maxStart = Math.max(0, len - grainDurSamples);
    start = Math.min(Math.max(0, start), maxStart);
    if (reverse) start = Math.min(Math.max(0, len - start - grainDurSamples), maxStart);

    free.active = true;
    free.pos = start;
    free.rate = reverse ? -grainRate : grainRate;
    free.remaining = grainDurSamples;
    free.ramp = Math.max(Math.round(0.004 * sr), Math.round((0.12 + 0.38 * shape) * size * sr));
    free.plateau = Math.max(0, grainDurSamples - 2 * free.ramp);
    free.age = 0;
    // StereoPanner equal-power: pan -1..1 -> L=cos, R=sin over ±45°.
    const theta = (pan + 1) * (Math.PI / 4);
    free.panL = Math.cos(theta);
    free.panR = Math.sin(theta);
    const overlap = Math.max(0.75, this.grainRate(sr) * size);
    free.peak = (this.vel * (p.gain ?? 0.8) * 0.7) / overlap;
    free.ch = sample.channels;
    this.spawned++;
  }
}

class GrainVoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sample = null; // {ch0, ch1, length, channels, sampleRate}
    this.voices = [];
    this.voiceCounter = 0;
    this.bpm = 120;
    this.params = {
      position: 0.25,
      size: 0.09,
      rate: 14,
      rateSync: 0,
      jitter: 0.15,
      scan: 0,
      spread: 0.5,
      reverse: 0,
      shape: 0.5,
      pRand: 0,
      pitch: 0,
      gain: 0.8,
      attack: 0.02,
      release: 0.4,
    };
    this.events = [];
    this.port.onmessage = (e) => this.handleMessage(e.data);
    // Initial state arrives via processorOptions — port messages to an
    // OfflineAudioContext's worklet are only delivered AFTER the render
    // finishes, so anything the first note needs must be constructor state.
    const init = options?.processorOptions;
    if (init) {
      if (init.params) Object.assign(this.params, init.params);
      if (typeof init.bpm === "number") this.bpm = init.bpm;
      if (init.sample) this.handleMessage({ type: "sample", ...init.sample });
    }
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "sample":
        if (!(msg.ch0 instanceof Float32Array) || msg.ch0.length === 0) return;
        this.sample = {
          ch0: msg.ch0,
          ch1: msg.ch1 instanceof Float32Array ? msg.ch1 : null,
          length: msg.ch0.length,
          channels: msg.ch1 instanceof Float32Array ? 2 : 1,
          sampleRate: msg.sampleRate || 44100,
        };
        return;
      case "noteOn":
        this.events.push({ ...msg, kind: "on" });
        return;
      case "noteOff":
        this.events.push({ ...msg, kind: "off" });
        return;
      case "panic":
        this.events.length = 0;
        for (const v of this.voices) {
          v.active = false;
          v.gate = false;
          v.dead = true;
          for (const g of v.grains) g.active = false;
        }
        return;
      case "bpm":
        if (typeof msg.value === "number" && msg.value > 10 && msg.value < 400) this.bpm = msg.value;
        return;
      case "param":
        if (typeof msg.value === "number") this.params[msg.name] = msg.value;
        return;
      default:
        return;
    }
  }

  triggerOn(ev, sr) {
    let voice = null;
    for (const v of this.voices) {
      if (!v.gate) {
        voice = v;
        break;
      }
    }
    if (!voice) {
      if (this.voices.length >= VOICES_MAX) {
        voice = this.voices.reduce((a, b) => (a.age <= b.age ? a : b));
      } else {
        voice = new GrainVoice(this.voiceCounter++, this.params);
        voice.bpm = this.bpm;
        this.voices.push(voice);
      }
    }
    voice.p = this.params;
    voice.bpm = this.bpm;
    voice.noteOn(ev, sr);
  }

  triggerOff(pitch, nowFrame, sr) {
    for (const v of this.voices) {
      if (v.active && v.gate && v.pitch === pitch) v.release(nowFrame, sr);
    }
  }

  process(inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0].length > 1 ? outputs[0][1] : null;
    if (!outL) return true;
    void inputs;
    this.processCalls = (this.processCalls || 0) + 1;
    const sr = globalThis.sampleRate || 44100;
    this.srSeen = sr;
    const blockStart = currentTime;
    const sample = this.sample;
    const p = this.params;

    for (let i = 0; i < outL.length; i++) {
      const frame = Math.round((blockStart + i / sr) * sr);
      this.lastFrame = frame;
      // Sample-accurate event dispatch (scheduler posts `when` ahead).
      for (let e = this.events.length - 1; e >= 0; e--) {
        const ev = this.events[e];
        if (Math.round(ev.when * sr) <= frame) {
          this.events.splice(e, 1);
          if (ev.kind === "on") this.triggerOn(ev, sr);
          else this.triggerOff(ev.pitch, frame, sr);
        }
      }

      let l = 0;
      let r = 0;

      for (const v of this.voices) {
        if (!v.active) continue;
        v.age++;
        v.p = p;
        v.bpm = this.bpm;

        // Voice amp envelope — exponential one-pole, fallback schedule shape.
        if (v.stage === "attack") {
          const tau = Math.max(0.002, p.attack ?? 0.02) / 3;
          v.env += (v.peak - v.env) * (1 - Math.exp(-1 / (tau * sr)));
          if (v.env > v.peak * 0.985) v.stage = "sustain";
        } else if (v.stage === "release") {
          const tau = Math.max(0.005, p.release ?? 0.4) / 3;
          v.env += (0 - v.env) * (1 - Math.exp(-1 / (tau * sr)));
        }
        if (!v.gate && frame >= v.offFrame) v.stage = "release";

        // Live playhead: spawn decisions read CURRENT params every grain.
        while (v.nextSpawn <= frame && v.nextSpawn < v.offFrame + 0.005 * sr) {
          v.spawn(v.nextSpawn, sr, sample);
          const rate = v.grainRate(sr);
          v.nextSpawn += rate > 0.01 ? Math.max(1, Math.round(sr / rate)) : sr * 10;
        }

        // Render active grains.
        let gl = 0;
        let gr = 0;
        for (const g of v.grains) {
          if (!g.active) continue;
          // Trapezoid envelope at the grain's own age (linear ramps, same
          // breakpoints as the fallback: ramp -> plateau -> ramp).
          let envg;
          if (g.age < g.ramp) envg = g.age / g.ramp;
          else if (g.age < g.ramp + g.plateau) envg = 1;
          else envg = Math.max(0, 1 - (g.age - g.ramp - g.plateau) / g.ramp);
          if (envg <= 0 && g.age > 0) {
            g.active = false;
            continue;
          }
          const idx = g.pos | 0;
          const frac = g.pos - idx;
          if (idx < 0 || idx >= sample.length - 1) {
            g.active = false;
            continue;
          }
          const s0 = sample.ch0[idx];
          const s1 = sample.ch0[idx + 1];
          let mono = s0 + (s1 - s0) * frac;
          let monoR = mono;
          if (g.ch === 2 && sample.ch1) {
            const t0 = sample.ch1[idx];
            const t1 = sample.ch1[idx + 1];
            monoR = t0 + (t1 - t0) * frac;
          }
          gl += mono * g.panL * envg;
          gr += monoR * g.panR * envg;
          g.pos += g.rate;
          g.age++;
          g.remaining--;
          if (g.remaining <= 0) g.active = false;
        }

        const amp = v.env;
        l += gl * amp;
        r += gr * amp;

        // Voice death: released, faded, no grains left, spawn window closed.
        if (
          !v.gate &&
          v.stage === "release" &&
          v.env < 0.0004 &&
          frame >= v.offFrame + 0.005 * sr &&
          !v.grains.some((g) => g.active)
        ) {
          v.active = false;
          v.dead = true;
        }
      }

      this.voices = this.voices.filter((v) => !v.dead);
      outL[i] = Math.max(-8, Math.min(8, l));
      if (outR) outR[i] = Math.max(-8, Math.min(8, r));
    }
    return true;
  }
}

registerProcessor("granular-voice-processor", GrainVoiceProcessor);
