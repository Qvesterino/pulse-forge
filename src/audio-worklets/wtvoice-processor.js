/**
 * Wavetable voice engine — per-sample synth voices in ONE AudioWorklet.
 *
 * Phase-2 pilot for the voice-worklet architecture: the whole wavetable voice
 * (unison oscillator bank, morph/scan position, sub oscillator, stability-
 * clamped state-variable filter, attack/release envelope and a per-voice
 * modulation matrix) is computed sample-accurately here instead of as a
 * scheduled main-thread WebAudio graph.
 *
 * What per-sample computation unlocks (impossible on the main thread):
 *  - a modulation matrix evaluated per voice per sample
 *    (env / LFO / velocity / pressure -> morph / cutoff / detune / amp)
 *    with per-voice decorrelated LFO phase,
 *  - true per-sample table traversal (scan) with no source-swap crossfades,
 *  - live parameter changes retargeting every sounding voice instantly.
 *
 * Determinism contract: no Math.random anywhere. Unison and LFO phases derive
 * from a voice counter; the identical message sequence produces identical
 * samples, so offline renders match live playback.
 *
 * Messaging (node.port, main thread -> worklet):
 *  {type:"tables", levels:[Float32Array[]], ks:number[]}  mipmapped table
 *  {type:"noteOn", pitch, velocity, when}                 absolute ctx time
 *  {type:"noteOff", pitch, when}
 *  {type:"pressure", pitch, value}                        MPE poly aftertouch
 *  {type:"panic"}
 *  {type:"param", name, value}                            k-rate, immediate
 *
 * Messages take effect at their absolute time through a sample-accurate
 * event queue (the scheduler posts `when` values ahead of audio time).
 */

function svfCoeffs(f, q, sr) {
  let ff = 2 * Math.sin((Math.PI * Math.min(f, sr * 0.24)) / sr);
  let qq = 2 - 2 * Math.max(0, Math.min(1, q));
  const fqMax = (4 - ff * ff) * 0.49; // stability clamp shared with svfilter-processor
  if (ff * qq > fqMax) qq = fqMax / ff;
  return { f: ff, q: qq };
}

const UNISON_MAX = 8;
const VOICES_MAX = 8;
const GOLDEN = 2.399963; // golden-angle spread for per-voice phase decorrelation

class WtTables {
  constructor() {
    this.levels = null; // levels[level][frame] = Float32Array
    this.ks = [1];
  }

  set(msg) {
    if (!Array.isArray(msg.levels) || msg.levels.length === 0) return;
    this.levels = msg.levels.map((level) => level.map((f) => Float32Array.from(f)));
    this.ks = Array.isArray(msg.ks) && msg.ks.length > 0 ? Array.from(msg.ks) : [1];
  }

  frameCount() {
    return this.levels ? this.levels[0].length : 0;
  }

  frameLength() {
    return this.levels ? this.levels[0][0].length : 0;
  }

  /** Most-harmonic level whose top harmonic stays under Nyquist at f0. */
  pickLevel(f0) {
    const limit = 0.475 * (globalThis.sampleRate || 44100);
    for (let m = 0; m < this.ks.length; m++) {
      if (this.ks[m] * f0 <= limit) return m;
    }
    return this.ks.length - 1;
  }
}

class WtVoice {
  constructor(index, params) {
    this.index = index;
    this.p = params;
    this.active = false;
    this.gate = false;
    this.dead = true;
    this.pitch = 60;
    this.f0 = 261.63;
    this.vel = 0;
    this.pressure = 0;
    this.levelIndex = 0;
    this.morphBase = params.morph;
    this.scanPos = 0;
    this.lfoPhase = (index * GOLDEN) % 1;
    this.env = 0;
    this.stage = "off"; // off | attack | sustain | release
    this.age = 0;
    this.svfF = 0;
    this.svfQ = 1;
    this.lastCutoff = -1;
    this.subPhase = 0;
    this.f1L = 0;
    this.f2L = 0;
    this.f1R = 0;
    this.f2R = 0;
    this.copyPhase = new Float32Array(UNISON_MAX + 2);
    this.copyDetune = new Float32Array(UNISON_MAX + 2);
    this.copyLevel = new Float32Array(UNISON_MAX + 2);
    this.panL = new Float32Array(UNISON_MAX + 2);
    this.panR = new Float32Array(UNISON_MAX + 2);
    this.copyCount = 0;
  }

  noteOn(pitch, velocity) {
    this.active = true;
    this.gate = true;
    this.dead = false;
    this.pitch = pitch;
    this.f0 = 440 * Math.pow(2, (pitch - 69) / 12);
    this.vel = velocity;
    this.pressure = 0;
    this.env = 0;
    this.stage = "attack";
    this.morphBase = this.p.morph;
    this.scanPos = this.morphBase * (this.p.tableFrames - 1);
    this.levelIndex = this.p.pickLevel(this.f0);
    this.lfoPhase = (this.index * GOLDEN) % 1;
    this.refreshCopies();
    this.lastCutoff = -1;
  }

  refreshCopies() {
    const unison = Math.max(1, Math.min(UNISON_MAX, Math.round(this.p.unison)));
    const spread = this.p.spread;
    const detune = this.p.detune;
    this.copyDetune[0] = 0;
    this.copyLevel[0] = 0.5;
    this.panL[0] = 0.7071;
    this.panR[0] = 0.7071;
    this.copyDetune[1] = detune;
    this.copyLevel[1] = 0.45;
    this.panL[1] = 0.7071;
    this.panR[1] = 0.7071;
    this.copyCount = 2;
    if (unison > 1) {
      for (let u = 0; u < unison; u++) {
        const t = unison === 1 ? 0 : (u / (unison - 1)) * 2 - 1;
        const idx = 2 + u;
        this.copyDetune[idx] = detune * 0.5 + t * spread;
        this.copyLevel[idx] = 0.4 / Math.sqrt(unison);
        const pan = t * 0.6;
        this.panL[idx] = Math.cos(((pan + 1) * Math.PI) / 4);
        this.panR[idx] = Math.sin(((pan + 1) * Math.PI) / 4);
        this.copyCount++;
      }
    }
  }

  release() {
    this.gate = false;
    this.stage = "release";
  }
}

class WtVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tables = new WtTables();
    this.voices = [];
    this.voiceCounter = 0;
    this.events = []; // {when, kind, pitch, velocity} sorted by `when`
    this.params = {
      morph: 0.3,
      morphRate: 0,
      morphDepth: 0.5,
      scanRate: 0,
      detune: 7,
      sub: 0.2,
      unison: 1,
      spread: 0,
      cutoff: 12000,
      resonance: 1,
      mode: 0,
      keytrack: 0,
      level: -6,
      attack: 0.01,
      release: 0.25,
      modASrc: 0,
      modADst: 0,
      modAAmt: 0,
      modBSrc: 0,
      modBDst: 1,
      modBAmt: 0,
      modLfoRate: 2,
      tableFrames: 8,
      pickLevel: () => 0,
    };
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "tables":
        this.tables.set(msg);
        this.params.tableFrames = this.tables.frameCount();
        this.params.pickLevel = (f0) => this.tables.pickLevel(f0);
        break;
      case "noteOn":
        this.events.push({
          when: Math.max(msg.when ?? currentTime, currentTime),
          kind: "on",
          pitch: msg.pitch,
          velocity: msg.velocity,
        });
        this.events.sort((a, b) => a.when - b.when);
        break;
      case "noteOff":
        this.events.push({ when: Math.max(msg.when ?? currentTime, currentTime), kind: "off", pitch: msg.pitch });
        this.events.sort((a, b) => a.when - b.when);
        break;
      case "pressure":
        for (const v of this.voices) {
          if (v.active && v.pitch === msg.pitch) v.pressure = Math.max(0, Math.min(1, msg.value));
        }
        break;
      case "panic":
        this.voices.length = 0;
        this.events.length = 0;
        break;
      case "param":
        if (typeof msg.name === "string" && msg.name in this.params && typeof msg.value === "number") {
          this.params[msg.name] = msg.value;
        }
        break;
    }
  }

  drainDue(t, dueOn, dueOff) {
    while (this.events.length > 0 && this.events[0].when <= t) {
      const ev = this.events.shift();
      if (ev.kind === "on") dueOn.push(ev);
      else dueOff.push(ev);
    }
  }

  triggerOn(ev) {
    // Voice stealing: prefer a released voice, else the oldest sounding one.
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
        voice = new WtVoice(this.voiceCounter++, this.params);
        this.voices.push(voice);
      }
    }
    voice.noteOn(ev.pitch, ev.velocity);
  }

  triggerOff(pitch) {
    for (const v of this.voices) {
      if (v.active && v.gate && v.pitch === pitch) v.release();
    }
  }

  process(inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0].length > 1 ? outputs[0][1] : null;
    if (!outL) return true;
    const sr = globalThis.sampleRate || 44100;
    const dt = 1 / sr;
    const blockStart = currentTime;
    const dueOn = [];
    const dueOff = [];
    const p = this.params;
    const N = p.tableFrames;
    const tN1 = Math.max(1, N - 1);
    const frameLen = this.tables.frameLength();

    for (let i = 0; i < outL.length; i++) {
      const t = blockStart + i * dt;
      dueOn.length = 0;
      dueOff.length = 0;
      this.drainDue(t, dueOn, dueOff);
      for (const ev of dueOn) this.triggerOn(ev);
      for (const ev of dueOff) this.triggerOff(ev.pitch);

      let l = 0;
      let r = 0;

      for (const v of this.voices) {
        if (!v.active) continue;
        // Amp envelope: exponential attack / release (one-pole per sample).
        const tau = v.stage === "attack" ? Math.max(0.002, p.attack) / 3 : Math.max(0.005, p.release) / 3;
        // Sustain HOLDS the env at 1 — only release targets zero. (A previous
        // draft decayed during sustain, killing every note after ~50 ms.)
        if (v.stage === "attack") {
          const tau = Math.max(0.002, p.attack) / 3;
          v.env += (1 - v.env) * (1 - Math.exp(-dt / tau));
          if (v.env > 0.985) v.stage = "sustain";
        } else if (v.stage === "release") {
          const tauR = Math.max(0.005, p.release) / 3;
          v.env += (0 - v.env) * (1 - Math.exp(-dt / tauR));
          if (v.env < 0.0004) {
            v.dead = true;
            v.active = false;
            continue;
          }
        }

        // ── Modulation sources (per voice, per sample) ──
        const srcEnv = v.env;
        const srcLfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * p.modLfoRate * t + v.lfoPhase * 2 * Math.PI);
        const srcVel = v.vel;
        const srcPress = v.pressure;
        const srcA = p.modASrc === 0 ? srcEnv : p.modASrc === 1 ? srcLfo : p.modASrc === 2 ? srcVel : srcPress;
        const srcB = p.modBSrc === 0 ? srcEnv : p.modBSrc === 1 ? srcLfo : p.modBSrc === 2 ? srcVel : srcPress;

        // ── Morph / scan position (pair units, wrapping over the table) ──
        v.scanPos += tN1 * p.scanRate * dt;
        let pairPos = v.morphBase * tN1 + v.scanPos;
        // M RATE / M DEPTH crossfade wobble, room-clamped like the main thread
        const frac = pairPos - Math.floor(pairPos);
        pairPos +=
          Math.sin(2 * Math.PI * p.morphRate * t + v.lfoPhase * 2 * Math.PI) *
          p.morphDepth *
          Math.min(frac, 1 - frac) *
          0.9;
        // Mod routes -> morph (±2 pair units at full amount)
        pairPos += srcA * p.modAAmt * 2 * (p.modADst === 0 ? 1 : 0);
        pairPos += srcB * p.modBAmt * 2 * (p.modBDst === 0 ? 1 : 0);
        pairPos = ((pairPos % tN1) + tN1) % tN1;
        const ia = Math.floor(pairPos);
        const blend = pairPos - ia;
        const ib = (ia + 1) % N;

        // ── Per-voice cutoff: keytrack + mod routes, stability-clamped SVF ──
        const keytr = 1 + p.keytrack * (v.f0 / 261.63 - 1);
        const modCut =
          srcA * p.modAAmt * 2 * (p.modADst === 1 ? 1 : 0) + srcB * p.modBAmt * 2 * (p.modBDst === 1 ? 1 : 0);
        const cutoff = Math.min(18000, Math.max(60, p.cutoff * keytr * (1 + Math.max(-0.9, modCut))));
        if (Math.abs(cutoff - v.lastCutoff) > 0.01) {
          v.lastCutoff = cutoff;
          const c = svfCoeffs(cutoff, p.resonance, sr);
          v.svfF = c.f;
          v.svfQ = c.q;
        }
        const mode = Math.round(p.mode);

        const frames = this.tables.levels ? this.tables.levels[v.levelIndex] : null;
        if (!frames || frameLen === 0) continue;

        const dB = Math.pow(10, p.level / 20);
        const amp = v.env * v.vel * dB;
        let voiceL = 0;
        let voiceR = 0;

        // ── Unison oscillator bank: lerped frame read at the morph position ──
        for (let cI = 0; cI < v.copyCount; cI++) {
          v.copyPhase[cI] += v.f0 * Math.pow(2, v.copyDetune[cI] / 1200) * dt;
          if (v.copyPhase[cI] >= 1) v.copyPhase[cI] -= Math.floor(v.copyPhase[cI]);
          const posA = v.copyPhase[cI] * frameLen;
          const i0 = posA | 0;
          const fr = posA - i0;
          const sa = frames[ia];
          const sb = frames[ib];
          const a = sa[i0] ?? 0;
          const b = sa[i0 + 1] ?? a;
          const c = sb[i0] ?? 0;
          const d = sb[i0 + 1] ?? c;
          const sample = (a + (b - a) * fr) * (1 - blend) + (c + (d - c) * fr) * blend;
          voiceL += sample * v.copyLevel[cI] * v.panL[cI];
          voiceR += sample * v.copyLevel[cI] * v.panR[cI];
        }

        // ── Sub oscillator, one octave down, centred ──
        if (p.sub > 0.005) {
          v.subPhase += v.f0 * 0.5 * dt;
          if (v.subPhase >= 1) v.subPhase -= Math.floor(v.subPhase);
          const sub = Math.sin(2 * Math.PI * v.subPhase) * p.sub * 0.7;
          voiceL += sub;
          voiceR += sub;
        }

        // ── Chamberlin SVF (shared topology + stability clamp) ──
        let fL = voiceL;
        let fR = voiceR;
        if (v.svfF > 0) {
          const hpL = voiceL - v.f1L - v.svfQ * v.f2L;
          v.f2L += v.svfF * hpL;
          v.f1L += v.svfF * v.f2L;
          v.f2L = Math.max(-8, Math.min(8, v.f2L));
          v.f1L = Math.max(-8, Math.min(8, v.f1L));
          const hpR = voiceR - v.f1R - v.svfQ * v.f2R;
          v.f2R += v.svfF * hpR;
          v.f1R += v.svfF * v.f2R;
          v.f2R = Math.max(-8, Math.min(8, v.f2R));
          v.f1R = Math.max(-8, Math.min(8, v.f1R));
          if (mode === 1) {
            fL = hpL;
            fR = hpR;
          } else if (mode === 2) {
            fL = v.f2L;
            fR = v.f2R;
          } else {
            fL = v.f1L;
            fR = v.f1R;
          }
        }

        // ── Amp mod route + env ──
        const ampMod = srcA * p.modAAmt * (p.modADst === 3 ? 1 : 0) + srcB * p.modBAmt * (p.modBDst === 3 ? 1 : 0);
        const gain = amp * Math.max(0.1, 1 + ampMod);
        l += fL * gain;
        r += fR * gain;
        v.age++;
      }

      // Dead voices are compacted once per BLOCK (after the sample loop) —
      // the old per-sample `.filter` allocated a fresh array + closure on
      // every sample (~48k/s at 48 kHz), steady GC churn on the render
      // thread. Dead voices are skipped by the `!v.active` guard anyway.
      outL[i] = Math.max(-8, Math.min(8, l));
      if (outR) outR[i] = Math.max(-8, Math.min(8, r));
    }
    // In-place compaction: no allocation.
    let w = 0;
    for (let v = 0; v < this.voices.length; v++) {
      if (!this.voices[v].dead) this.voices[w++] = this.voices[v];
    }
    this.voices.length = w;
    return true;
  }
}

registerProcessor("wtvoice-processor", WtVoiceProcessor);
