/**
 * KOPA DSP CORE — the per-sample kick-designer voice engine (KOPA plan §3).
 *
 * Typed and pure: no AudioWorklet globals, no AudioContext, no clock reads.
 * The worklet wrapper (`src/kopa-worklet.entry.js`) owns the port and the
 * `currentFrame` plumbing; this class owns the SOUND (the tsarProcessor
 * split), so every rule below is directly vitest-testable and live/offline
 * share ONE code path.
 *
 * Architecture (each layer independent):
 *  - PITCH: pitch envelope from `pitchAmount` semitones above the target
 *    frequency down to it over `pitchTime`, with exp/lin/snap/hold curves.
 *    `keyTrack` 0 = fixed C2 (65.4 Hz), 1 = follow the MIDI note so the kick
 *    tunes with the 808.
 *  - CLICK: transient burst — noise / HP noise / sine / impulse — at
 *    `clickTone` with `clickDecay` and `clickLevel`.
 *  - BODY: `bodyDecay` sine/tri/saw (mixed by `bodyWave`, 2nd-harmonic
 *    `bodyHollow`) at `bodyTune` — the punch layer.
 *  - TAIL: long `tailDecay` sine at `tailTune` for 808-style booms.
 *  - SUB: phase-locked sine one octave under the body (`subTune`), phase
 *    derived from the body oscillator — deterministic, no free runner.
 *  - KICK HARMONICS: a body-phase-locked partial layer starts at the 2nd
 *    partial and follows KOPA's known pitch envelope. The separate GROW FX
 *    tracks arbitrary incoming bass; this layer is part of kick synthesis.
 *  - CHARACTER: 4 drive curves (soft/tube/hard/fold), `punch` glue and
 *    `stereo` spread; OUTPUT `level` in dB.
 *
 * EVENT MODEL (offline-parity contract, same interpreter shape as TSAR):
 * every timed message enters ONE queue with an absolute time; live they
 * arrive via port, offline the list is seeded via `processorOptions.events`.
 *
 * Determinism: no Math.random — the click noise is a seeded LCG advanced per
 * sample. Same events -> same samples.
 */

const MAX_VOICES = 16;
/** One-pole smoothing for click-free gain (≈2 ms @ 44.1k). */
const GAIN_RAMP_SEC = 0.002;
/** Fixed reference note (MIDI 36 = C2, 65.406 Hz) when keyTrack is off. */
const FIXED_HZ = 65.40639132514966;

export interface KopaEvent {
  type: "noteOn" | "noteOff" | "param" | "panic";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
  name?: string;
  value?: number;
}

interface Voice {
  index: number;
  active: boolean;
  gate: boolean;
  /** Note pitch (for noteOff matching). */
  pitch: number;
  /** Target fundamental (Hz). */
  targetF0: number;
  /** Pitch-envelope progress 0..1. */
  pitchT: number;
  /** Phase accumulators. */
  bodyPhase: number;
  tailPhase: number;
  /** Sub phase — advances at half the body rate (one octave under, seeded from
   *  the same note start, so it stays phase-locked and deterministic). */
  subPhase: number;
  /** Layer envelopes (one-pole exponential decay). */
  clickEnv: number;
  bodyEnv: number;
  tailEnv: number;
  harmonicEnv: number;
  /** MIDI velocity is applied once to the complete voice after its shaper. */
  velocity: number;
  /** Click noise LCG state. */
  noiseLcg: number;
  /** Previous noise value (HP click type). */
  noisePrev: number;
  /** Smoothed voice gain (click-free start/steal). */
  gain: number;
  /** Monotonic sample age for oldest-steal. */
  age: number;
  /** Samples since noteOn (pitch-envelope progress). */
  samples: number;
}

export interface KopaInitOptions {
  sampleRate: number;
  /** Pre-seeded events (offline): applied at their absolute times. */
  events?: KopaEvent[];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function midiToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** The four drive curves (soft/tube/hard/fold). */
function driveCurve(x: number, type: number): number {
  if (type === 0) return Math.tanh(x * 1.6) * 0.86; // Soft
  if (type === 1) return Math.tanh(x * 2.4) * 0.72 + Math.tanh(x * 4) * 0.18; // Tube
  if (type === 2) return clamp(x * 2.6, -1, 1); // Hard
  return Math.sin(x * Math.PI); // Fold (bounded by construction)
}

/**
 * The pitch envelope shape, exported so the editor's graphic and the DSP
 * share ONE implementation (the KOPA editor draws this curve — a second copy
 * in the UI could drift from the sound).
 *
 * `t` is the normalized envelope progress (0 at the hit, 1 when the pitch has
 * fallen), `curve` is the `pitchCurve` parameter (0 exp, 1 lin, 2 snap, 3 hold).
 */
export function pitchEnvAt(t: number, curve: number): number {
  if (curve === 0) return (1 - t) * (1 - t); // exp
  if (curve === 1) return 1 - t; // lin
  if (curve === 2) return t < 0.35 ? 1 : 0; // snap
  return t < 0.15 ? 1 : Math.max(0, 1 - (t - 0.15) / 0.85); // hold
}

/**
 * The layer decay coefficient: `env -= env * coef` per sample, so the
 * envelope reaches ~5 % after `decaySec`. Exported for the same reason as
 * `pitchEnvAt` — the editor draws the layer envelopes from it.
 */
export function kopaDecayCoef(decaySec: number, sampleRate: number): number {
  return Math.min(1, 1 / (decaySec * sampleRate * 0.33));
}

export class KopaProcessor {
  readonly sampleRate: number;
  private params: Record<string, number> = {};
  private voices: Voice[] = [];
  /** Pending timed events, sorted by `when`. */
  private events: KopaEvent[] = [];
  private voiceCounter = 0;
  private blockEvents: KopaEvent[] = [];
  /** Reused each block so the audio callback does not allocate scratch data. */
  private harmonicWeights = new Float64Array(17);

  constructor(options: KopaInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 44100;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(this.makeVoice(i));
    if (Array.isArray(options.events)) {
      for (const event of options.events) this.postEvent(event);
    }
  }

  private makeVoice(index: number): Voice {
    return {
      index,
      active: false,
      gate: false,
      pitch: 36,
      targetF0: FIXED_HZ,
      pitchT: 0,
      bodyPhase: 0,
      tailPhase: 0,
      subPhase: 0,
      clickEnv: 0,
      bodyEnv: 0,
      tailEnv: 0,
      harmonicEnv: 0,
      velocity: 1,
      noiseLcg: (0x9e3779b9 + index * 0x85ebca6b) >>> 0,
      noisePrev: 0,
      gain: 0,
      age: 0,
      samples: 0,
    };
  }

  applyParams(params: Record<string, number>): void {
    for (const [id, value] of Object.entries(params)) {
      if (Number.isFinite(value)) this.params[id] = value;
    }
  }

  setParam(name: string, value: number): void {
    if (typeof name === "string" && Number.isFinite(value)) this.params[name] = value;
  }

  postEvent(event: KopaEvent): void {
    if (!event || typeof event !== "object") return;
    const type = event.type;
    if (type !== "noteOn" && type !== "noteOff" && type !== "param" && type !== "panic") return;
    const when = typeof event.when === "number" && Number.isFinite(event.when) ? Math.max(0, event.when) : 0;
    const item: KopaEvent = { ...event, when };
    let insertAt = this.events.length;
    while (insertAt > 0 && this.events[insertAt - 1]!.when > when) insertAt--;
    this.events.splice(insertAt, 0, item);
  }

  private noteOn(pitch: number, velocity: number): void {
    const noteVelocity = Number.isFinite(velocity) ? clamp(velocity, 0, 1) : 1;
    // A zero-velocity note-on is silent and must not occupy or steal a voice.
    if (noteVelocity === 0) return;
    let voice = this.voices.find((candidate) => !candidate.active);
    if (!voice) {
      // Oldest-steal: the lowest note-order age is the longest-running voice.
      voice = this.voices.reduce((oldest, candidate) => (candidate.age < oldest.age ? candidate : oldest));
    }
    const keyTrack = (this.params.keyTrack ?? 1) >= 0.5;
    const midi = Number.isFinite(pitch) ? pitch : 36;
    voice.active = true;
    voice.gate = true;
    voice.pitch = midi;
    voice.targetF0 = keyTrack ? midiToHz(midi) : FIXED_HZ;
    voice.pitchT = 0;
    voice.bodyPhase = 0;
    voice.tailPhase = 0;
    voice.subPhase = 0;
    // Keep velocity separate from envelopes so it scales every layer exactly
    // once. MIDI note-on velocity 0 is valid silence; only a missing/invalid
    // value falls back to the instrument's full-velocity default.
    voice.velocity = noteVelocity;
    voice.clickEnv = 1;
    voice.bodyEnv = 1;
    voice.tailEnv = 1;
    voice.harmonicEnv = 1;
    voice.noiseLcg = (0x9e3779b9 + voice.index * 0x85ebca6b) >>> 0;
    voice.noisePrev = 0;
    voice.age = ++this.voiceCounter;
    voice.samples = 0;
  }

  private noteOff(pitch: number): void {
    // ONE SHOT lets the percussive envelopes finish independently of MIDI note
    // length. GATED preserves the established noteOff choke behavior.
    if ((this.params.triggerMode ?? 1) < 0.5) return;
    for (const voice of this.voices) {
      if (!voice.active || !voice.gate) continue;
      if (Number.isFinite(pitch) && voice.pitch !== pitch) continue;
      voice.gate = false;
    }
  }

  private panic(): void {
    for (const voice of this.voices) {
      voice.active = false;
      voice.gate = false;
    }
    this.events = [];
  }

  private applyEvent(event: KopaEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(Number(event.pitch ?? 36), Number(event.velocity ?? 1));
        break;
      case "noteOff":
        this.noteOff(Number.isFinite(event.pitch) ? Number(event.pitch) : NaN);
        break;
      case "param":
        if (typeof event.name === "string") this.setParam(event.name, Number(event.value));
        break;
      case "panic":
        this.panic();
        break;
    }
  }

  /**
   * Render `length` samples into `left`/`right` starting at absolute frame
   * `currentFrame`. Events apply at their exact sample boundary.
   */
  process(left: Float32Array, right: Float32Array, currentFrame: number): void {
    const sr = this.sampleRate;
    const frames = left.length;
    const blockStartSec = currentFrame / sr;
    const blockEndSec = (currentFrame + frames) / sr;

    // Drain events up to the block end; late ones apply immediately.
    const blockEvents = this.blockEvents;
    blockEvents.length = 0;
    while (this.events.length > 0 && this.events[0]!.when < blockEndSec) {
      const next = this.events.shift()!;
      if (next.when >= blockStartSec) blockEvents.push(next);
      else this.applyEvent(next);
    }
    let eventCursor = 0;

    // Per-block parameter snapshot (all per-sample work below uses it).
    const pitchAmount = this.params.pitchAmount ?? 24;
    const pitchTimeSec = clamp(this.params.pitchTime ?? 40, 5, 200) / 1000;
    const pitchCurve = Math.round(clamp(this.params.pitchCurve ?? 0, 0, 3));
    const clickType = Math.round(clamp(this.params.clickType ?? 0, 0, 3));
    const clickTone = clamp(this.params.clickTone ?? 2500, 300, 9000);
    const clickDecaySec = clamp(this.params.clickDecay ?? 3, 0.2, 20) / 1000;
    const clickLevel = clamp(this.params.clickLevel ?? 0.35, 0, 1);
    const bodyTune = this.params.bodyTune ?? 0;
    const bodyDecay = clamp(this.params.bodyDecay ?? 0.35, 0.03, 2);
    const bodyHollow = clamp(this.params.bodyHollow ?? 0.25, 0, 1);
    const bodyWave = Math.round(clamp(this.params.bodyWave ?? 0, 0, 2));
    const tailDecay = clamp(this.params.tailDecay ?? 0.4, 0.05, 3);
    const tailLevel = clamp(this.params.tailLevel ?? 0.25, 0, 1);
    const tailTune = this.params.tailTune ?? 0;
    const subLevel = clamp(this.params.subLevel ?? 0.3, 0, 1);
    const subTune = this.params.subTune ?? 0;
    const harmonicLevel = clamp(this.params.harmonicLevel ?? 0.25, 0, 1);
    const harmonicTone = clamp(this.params.harmonicTone ?? 0.35, 0, 1);
    const harmonicRange = Math.round(clamp(this.params.harmonicRange ?? 2, 1, 4));
    const harmonicMaxPartial = Math.pow(2, harmonicRange);
    const harmonicDecay = clamp(this.params.harmonicDecay ?? 0.25, 0.03, 2);
    const harmonicCharacter = Math.round(clamp(this.params.harmonicCharacter ?? 0, 0, 2));
    const drive = clamp(this.params.drive ?? 0.25, 0, 1);
    const driveType = Math.round(clamp(this.params.driveType ?? 0, 0, 3));
    const punch = clamp(this.params.punch ?? 0.2, 0, 1);
    const stereo = clamp(this.params.stereo ?? 0, 0, 1);
    const level = Math.pow(10, clamp(this.params.level ?? -6, -24, 6) / 20);

    // Mod matrix: sources ENV(0)/LFO(1)/VEL(2)/PRESS(3), destination AMP(3).
    const modASrc = Math.round(clamp(this.params.modASrc ?? 0, 0, 3));
    const modADst = Math.round(clamp(this.params.modADst ?? 0, 0, 3));
    const modAAmt = clamp(this.params.modAAmt ?? 0, -1, 1);
    const modBSrc = Math.round(clamp(this.params.modBSrc ?? 0, 0, 3));
    const modBDst = Math.round(clamp(this.params.modBDst ?? 0, 0, 3));
    const modBAmt = clamp(this.params.modBAmt ?? 0, -1, 1);
    const modLfoRate = clamp(this.params.modLfoRate ?? 2, 0, 12);
    const lfoBase = (currentFrame / sr) * modLfoRate;

    // One-pole decay coefficients: reach ~5 % after `decaySec`.
    const clickCoef = Math.min(1, 1 / (clickDecaySec * sr * 0.33));
    const bodyCoef = Math.min(1, 1 / (bodyDecay * sr * 0.33));
    const tailCoef = Math.min(1, 1 / (tailDecay * sr * 0.33));
    const harmonicCoef = Math.min(1, 1 / (harmonicDecay * sr * 0.33));
    const gainCoeff = Math.min(1, 1 / (GAIN_RAMP_SEC * sr));
    const twoPi = 2 * Math.PI;

    // The layer deliberately omits the fundamental. Tone blends the 2nd and
    // 3rd partials; higher partials extend the stack at a restrained level.
    // Normalize once per block so range changes the spectrum, not peak gain.
    const harmonicWeights = this.harmonicWeights;
    harmonicWeights.fill(0);
    let harmonicWeightSum = 0;
    for (let partial = 2; partial <= harmonicMaxPartial; partial++) {
      const weight =
        partial === 2 && harmonicMaxPartial >= 3
          ? 1 - harmonicTone
          : partial === 3
            ? harmonicTone
            : partial === 2
              ? 1
              : 0.25 / (partial - 1);
      harmonicWeights[partial] = weight;
      harmonicWeightSum += weight;
    }
    const harmonicNorm = harmonicWeightSum > 0 ? 1 / harmonicWeightSum : 0;

    for (let frame = 0; frame < frames; frame++) {
      const frameTime = (currentFrame + frame) / sr;
      while (eventCursor < blockEvents.length && blockEvents[eventCursor]!.when <= frameTime) {
        this.applyEvent(blockEvents[eventCursor]!);
        eventCursor += 1;
      }

      let outL = 0;
      let outR = 0;

      for (const voice of this.voices) {
        if (!voice.active) continue;

        // --- PITCH envelope: amount -> 0 over pitchTime ----------------
        voice.pitchT = pitchTimeSec > 0 ? Math.min(1, voice.samples / (pitchTimeSec * sr)) : 1;
        const t = voice.pitchT;
        const pitchEnv = pitchEnvAt(t, pitchCurve);
        const f0 = voice.targetF0 * Math.pow(2, (pitchAmount * pitchEnv) / 12);

        // --- layer envelopes ---------------------------------------------
        voice.clickEnv = Math.max(0, voice.clickEnv - voice.clickEnv * clickCoef);
        voice.bodyEnv = Math.max(0, voice.bodyEnv - voice.bodyEnv * bodyCoef);
        voice.tailEnv = Math.max(0, voice.tailEnv - voice.tailEnv * tailCoef);
        voice.harmonicEnv = Math.max(0, voice.harmonicEnv - voice.harmonicEnv * harmonicCoef);
        if (!voice.gate) {
          // noteOff chokes a percussive one-shot quickly.
          voice.bodyEnv *= 0.98;
          voice.tailEnv *= 0.99;
          voice.clickEnv *= 0.9;
          voice.harmonicEnv *= 0.98;
        }
        if (voice.bodyEnv < 1e-5 && voice.tailEnv < 1e-5 && voice.clickEnv < 1e-5 && voice.harmonicEnv < 1e-5) {
          voice.active = false;
          continue;
        }

        // --- oscillators --------------------------------------------------
        // The pitch envelope applies to the body (and therefore the sub);
        // the tail rides the same target for a consistent boom.
        const bodyF = f0 * Math.pow(2, bodyTune / 12);
        const tailF = voice.targetF0 * Math.pow(2, tailTune / 12);
        const subF = (bodyF / 2) * Math.pow(2, subTune / 12);
        voice.bodyPhase += (twoPi * bodyF) / sr;
        voice.tailPhase += (twoPi * tailF) / sr;
        voice.subPhase += (twoPi * subF) / sr;
        if (voice.bodyPhase >= twoPi) voice.bodyPhase -= twoPi;
        if (voice.tailPhase >= twoPi) voice.tailPhase -= twoPi;
        if (voice.subPhase >= twoPi) voice.subPhase -= twoPi;

        let body: number;
        if (bodyWave === 0) body = Math.sin(voice.bodyPhase);
        else if (bodyWave === 1)
          body = 1 - 2 * Math.abs(voice.bodyPhase / Math.PI - 1); // tri
        else body = voice.bodyPhase / Math.PI - 1; // saw (-1..1)
        const bodySignal = (body + bodyHollow * Math.sin(2 * voice.bodyPhase)) / (1 + bodyHollow);

        // Sub: one octave under the (tuned) body, own accumulator seeded with
        // the body phase at noteOn => phase-locked, deterministic, mono.
        const subSignal = Math.sin(voice.subPhase);

        // Kick harmonics: synthesize upper partials from the same body phase.
        // Starting at partial 2 creates the missing-fundamental illusion;
        // partials above Nyquist are skipped instead of aliasing back down.
        let harmonicSignal = 0;
        if (harmonicLevel > 0 && harmonicNorm > 0) {
          for (let partial = 2; partial <= harmonicMaxPartial; partial++) {
            const frequency = bodyF * partial;
            if (frequency >= sr * 0.45) continue;
            harmonicSignal += harmonicWeights[partial]! * Math.sin(voice.bodyPhase * partial);
          }
          harmonicSignal *= harmonicNorm;
          if (harmonicCharacter === 1) harmonicSignal = Math.tanh(harmonicSignal * 1.7) * 0.86;
          else if (harmonicCharacter === 2) harmonicSignal = Math.sin(harmonicSignal * Math.PI);
        }

        // Click transient (deterministic noise via LCG).
        const lcg = (Math.imul(voice.noiseLcg, 1664525) + 1013904223) >>> 0;
        voice.noiseLcg = lcg;
        const noise = (lcg / 0xffffffff) * 2 - 1;
        let click: number;
        if (clickType === 0) click = noise;
        else if (clickType === 1) {
          // HP noise: first difference of the LCG stream.
          click = noise - voice.noisePrev;
          voice.noisePrev = noise;
        } else if (clickType === 2) click = Math.sin((twoPi * clickTone * frame) / sr);
        else {
          // A short bipolar impulse is keyed to this hit's sample age, never
          // the monotonic voice-steal order (`age`).
          click = voice.samples === 0 ? 1 : voice.samples === 1 ? -0.65 : voice.samples === 2 ? 0.25 : 0;
        }

        let sample =
          bodySignal * voice.bodyEnv * 0.9 +
          Math.sin(voice.tailPhase) * voice.tailEnv * tailLevel * 0.9 +
          subSignal * Math.max(voice.bodyEnv, voice.tailEnv) * subLevel * 0.5 +
          harmonicSignal * voice.harmonicEnv * harmonicLevel * 0.55 +
          click * voice.clickEnv * clickLevel;

        // --- modulation (AMP destination only) ----------------------------
        const lfo = Math.sin(twoPi * (lfoBase + voice.index * 0.6180339887498949));
        if (modADst === 3) {
          const src = modASrc === 0 ? voice.bodyEnv : modASrc === 1 ? lfo : modASrc === 2 ? voice.velocity : 0;
          sample *= 1 + src * modAAmt;
        }
        if (modBDst === 3) {
          const src = modBSrc === 0 ? voice.bodyEnv : modBSrc === 1 ? lfo : modBSrc === 2 ? voice.velocity : 0;
          sample *= 1 + src * modBAmt;
        }

        // --- drive + punch + level ------------------------------------------
        const driven = drive > 0 ? sample * (1 - drive) + driveCurve(sample * (1 + drive), driveType) * drive : sample;
        const glued = punch > 0 ? driven / (1 + punch * Math.abs(driven) * 1.5) : driven;

        voice.gain += ((voice.gate ? 1 : 0) - voice.gain) * gainCoeff;
        const mono = glued * voice.gain * voice.velocity * level;
        // stereo widens the correlated layers; default 0 keeps the kick mono.
        outL += mono * (1 + stereo * 0.25);
        outR += mono * (1 - stereo * 0.25);
        voice.samples += 1;
      }

      left[frame] = outL * 0.5;
      right[frame] = outR * 0.5;
    }
  }

  /** OFFLINE ONLY — events buffered but not yet rendered (test hook). */
  pendingEventCount(): number {
    return this.events.length;
  }
}
