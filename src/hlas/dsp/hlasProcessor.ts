/**
 * HĽAS DSP core (ADR 0059) — a formant lead: source-filter synthesis.
 *
 * A glottal source (saw↔pulse mix) plus deterministic breath noise feeds
 * three PARALLEL RBJ bandpass biquads at the vowel formants (the A/E/I/O/U
 * table carried from the spectral instrument's registry lineage — fixed
 * linguistic data with attribution, so the "no tables in the worklet"
 * harmonyContext rule does not apply), each scaled by its band gain
 * (1/0.6/0.38), summed into a TILT-less lead path.
 *
 * The vowel pair MORPH interpolates the formant frequencies linearly;
 * MPE timbre (CC74) drives the morph and MPE pressure drives the breath,
 * per note (the ADR 0049 contract). Formant coefficients glide at a
 * ~2 kHz control rate so vowel morphs slide instead of stepping.
 *
 * Deterministic: breath noise draws from a per-note LCG seeded at noteOn —
 * live and offline render identically given the same events (the offline
 * `processorOptions.events` seed). Bounded: 6 voices (oldest-steal),
 * preallocated per-voice state, zero allocation in the render path.
 */

export interface HlasEvent {
  type: "noteOn" | "noteOff" | "panic" | "timbre" | "breath";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
  /** MPE timbre 0..1 → vowel morph override for this note. */
  timbre?: number;
  /** MPE pressure 0..1 → breath override for this note. */
  pressure?: number;
}

export interface HlasInitOptions {
  sampleRate: number;
  events?: HlasEvent[];
}

const MAX_VOICES = 6;
/** [F1, F2, F3] in Hz for A/E/I/O/U — carried from the spectral
 * instrument's registry lineage (VOWEL_FORMANTS); fixed linguistic data. */
const VOWEL_FORMANTS: number[][] = [
  [800, 1150, 2900], // A
  [400, 1600, 2700], // E
  [250, 1750, 2900], // I
  [400, 800, 2600], // O
  [350, 700, 2400], // U
];
const BAND_GAINS = [1, 0.6, 0.38];
const BAND_Q = [5, 6, 7];
const VIB_DELAY_SEC = 0.25;

interface Voice {
  active: boolean;
  gate: boolean;
  /** Glide-current and target frequency. */
  f0: number;
  targetF0: number;
  basePitch: number;
  vel: number;
  age: number;
  /** Source phase (cycles), vibrato phase, note age in samples. */
  phase: number;
  vibPhase: number;
  noteAge: number;
  /** Per-note morph/breath overrides (−1 = use the params). */
  morph: number;
  breath: number;
  /** Envelope: 0 attack, 1 sustain, 2 release, 3 off. */
  stage: 0 | 1 | 2 | 3;
  env: number;
  gain: number;
  /** Breath noise LCG. */
  lcg: number;
  /** 3 parallel bandpass biquads × [x1, x2, y1, y2]. */
  bpState: Float32Array;
  bpCoef: Float32Array; // 3 × [b0, b1, b2, a1, a2]
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class HlasProcessor {
  private sampleRate: number;
  private params: Record<string, number> = {};
  private events: HlasEvent[] = [];
  private voices: Voice[] = [];
  private voiceCounter = 0;
  private blockEvents: HlasEvent[] = [];
  private outPeak = 0;

  constructor(options: HlasInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        gate: false,
        f0: 261.63,
        targetF0: 261.63,
        basePitch: 60,
        vel: 0.8,
        age: 0,
        phase: 0,
        vibPhase: 0,
        noteAge: 0,
        morph: -1,
        breath: -1,
        stage: 3,
        env: 0,
        gain: 0,
        lcg: 1,
        bpState: new Float32Array(12),
        bpCoef: new Float32Array(15),
      });
    }
    if (options.events) for (const event of options.events) this.postEvent(event);
  }

  applyParams(values: Record<string, number>): void {
    for (const [key, value] of Object.entries(values)) {
      if (Number.isFinite(value)) this.params[key] = value;
    }
  }

  setParam(name: string, value: number): void {
    if (Number.isFinite(value)) this.params[name] = value;
  }

  postEvent(event: HlasEvent): void {
    if (!Number.isFinite(event.when)) return;
    this.events.push(event);
    for (let i = this.events.length - 1; i > 0 && this.events[i - 1]!.when > event.when; i--) {
      const tmp = this.events[i - 1]!;
      this.events[i - 1] = this.events[i]!;
      this.events[i] = tmp;
    }
  }

  /** RBJ bandpass (constant peak) coefficients for one formant band. */
  private bandCoeffs(out: Float32Array, slot: number, freq: number, q: number): void {
    const f = clamp(freq, 40, this.sampleRate * 0.45);
    const w = (2 * Math.PI * f) / this.sampleRate;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const den = 1 + alpha;
    out[slot] = alpha / den;
    out[slot + 1] = 0;
    out[slot + 2] = -alpha / den;
    out[slot + 3] = (-2 * cw) / den;
    out[slot + 4] = (1 - alpha) / den;
  }

  /** morph −1 = "use the MORPH param"; 0..1 = the per-note timbre override. */
  private morphValue(voice: Voice): number {
    return voice.morph >= 0 ? voice.morph : clamp(this.params.morph ?? 0, 0, 1);
  }

  /** Recompute the three bandpass coefficient sets for a voice's vowel. */
  private computeFormants(voice: Voice, morph: number): void {
    const scale = clamp(this.params.formantScale ?? 1, 0.5, 2);
    const a = clamp(Math.round(this.params.vowelA ?? 0), 0, 4);
    const b = clamp(Math.round(this.params.vowelB ?? 2), 0, 4);
    const fa = VOWEL_FORMANTS[a]!;
    const fb = VOWEL_FORMANTS[b]!;
    for (let band = 0; band < 3; band++) {
      const freq = (fa[band]! + (fb[band]! - fa[band]!) * morph) * scale;
      this.bandCoeffs(voice.bpCoef, band * 5, freq, BAND_Q[band]!);
    }
  }

  private noteOn(pitch: number, velocity: number, timbre?: number, pressure?: number): void {
    if (!Number.isFinite(pitch)) return;
    let voice = this.voices.find((candidate) => !candidate.active);
    if (!voice) voice = this.voices.reduce((oldest, c) => (c.age < oldest.age ? c : oldest));
    voice.active = true;
    voice.gate = true;
    voice.basePitch = pitch;
    voice.targetF0 = midiToHz(pitch);
    const glide = clamp(this.params.glide ?? 0.06, 0, 1.5);
    voice.f0 = glide > 0.001 ? voice.f0 : voice.targetF0;
    voice.vel = clamp(velocity, 0, 1);
    voice.age = ++this.voiceCounter;
    voice.morph = Number.isFinite(timbre) ? clamp(timbre as number, 0, 1) : -1;
    voice.breath = Number.isFinite(pressure) ? clamp(pressure as number, 0, 1) : -1;
    voice.stage = 0;
    voice.env = 0;
    voice.gain = 0;
    voice.phase = 0;
    voice.vibPhase = 0;
    voice.noteAge = 0;
    voice.lcg = (0x9e3779b9 ^ Math.imul(pitch + 1, 2654435761) ^ Math.imul(this.voiceCounter, 40503)) >>> 0;
    this.computeFormants(voice, this.morphValue(voice));
  }

  private noteOff(pitch: number): void {
    for (const voice of this.voices) {
      // gate=false AND stage=2: the process loop's release branch runs on
      // stage — gate alone would leave an attack/sustain voice holding
      // forever (measured: the release spec stayed active past its window).
      if (voice.active && voice.gate && voice.basePitch === pitch) {
        voice.gate = false;
        if (voice.stage === 0 || voice.stage === 1) voice.stage = 2;
      }
    }
  }

  applyEvent(event: HlasEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8, event.timbre, event.pressure);
        break;
      case "timbre":
      case "breath": {
        // Live per-note expression: update the override IN PLACE — the
        // envelope keeps singing (a re-attack per modwheel move would be
        // the wrong instrument entirely).
        if (!Number.isFinite(event.pitch)) break;
        const value = event.type === "timbre" ? event.timbre : event.pressure;
        if (!Number.isFinite(value)) break;
        const clamped = clamp(value as number, 0, 1);
        for (const voice of this.voices) {
          if (voice.active && voice.basePitch === (event.pitch as number)) {
            if (event.type === "timbre") voice.morph = clamped;
            else voice.breath = clamped;
          }
        }
        break;
      }
      case "noteOff":
        if (Number.isFinite(event.pitch)) this.noteOff(event.pitch as number);
        break;
      case "panic":
        for (const voice of this.voices) {
          voice.active = false;
          voice.gate = false;
          voice.stage = 3;
          voice.env = 0;
          voice.gain = 0;
        }
        break;
    }
  }

  private lcgDraw(voice: Voice): number {
    let state = voice.lcg;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    voice.lcg = state;
    return state / 0x100000000;
  }

  /**
   * Render one block. Per-sample event dispatch; the vowel formant
   * coefficients glide at a ~2 kHz control rate so morphs slide.
   */
  process(left: Float32Array, right: Float32Array, currentFrame: number): void {
    const sr = this.sampleRate;
    const frames = left.length;
    const blockStartSec = currentFrame / sr;
    const blockEndSec = (currentFrame + frames) / sr;

    const blockEvents = this.blockEvents;
    blockEvents.length = 0;
    while (this.events.length > 0 && this.events[0]!.when < blockEndSec) {
      const next = this.events.shift()!;
      if (next.when >= blockStartSec) blockEvents.push(next);
      else this.applyEvent(next);
    }
    let eventCursor = 0;

    const attack = clamp(this.params.attack ?? 0.02, 0.002, 1.5);
    const release = clamp(this.params.release ?? 0.25, 0.02, 3);
    const level = clamp(this.params.level ?? 0.8, 0, 1.5) * 0.55;
    const breathBase = clamp(this.params.breath ?? 0.2, 0, 1);
    const pulse = clamp(this.params.pulse ?? 0.3, 0, 1);
    const glide = clamp(this.params.glide ?? 0.06, 0, 1.5);
    const glideCoeff = glide > 0.001 ? Math.min(1, 1 / (glide * sr * 0.3)) : 1;
    const vibRate = clamp(this.params.vibratoRate ?? 5.5, 0.5, 9);
    const vibDepth = clamp(this.params.vibratoDepth ?? 14, 0, 60);
    const vibDelaySamples = VIB_DELAY_SEC * sr;

    left.fill(0);
    right.fill(0);
    let peak = 0;
    let controlTick = 24;

    for (let frame = 0; frame < frames; frame++) {
      const frameTime = (currentFrame + frame) / sr;
      while (eventCursor < blockEvents.length && blockEvents[eventCursor]!.when <= frameTime) {
        this.applyEvent(blockEvents[eventCursor]!);
        eventCursor += 1;
      }

      let mix = 0;
      for (const voice of this.voices) {
        if (!voice.active) continue;

        // Envelope (lead: attack → sustain → release).
        if (voice.stage === 0) {
          voice.env += 1 / (attack * sr);
          if (voice.env >= 1) {
            voice.env = 1;
            voice.stage = 1;
          }
        } else if (voice.stage === 2) {
          voice.env -= 1 / (release * sr);
          if (voice.env <= 0) {
            voice.env = 0;
            voice.stage = 3;
            voice.active = false;
            continue;
          }
        }
        const gainTarget = voice.gate || voice.stage !== 2 ? 1 : 0;
        voice.gain += (gainTarget - voice.gain) * Math.min(1, 1 / (0.004 * sr));
        if (!voice.gate && voice.gain < 1e-3 && voice.env <= 0.001) {
          voice.active = false;
          continue;
        }

        // Glide toward the target.
        if (voice.f0 !== voice.targetF0) {
          voice.f0 += (voice.targetF0 - voice.f0) * glideCoeff;
          if (Math.abs(voice.f0 - voice.targetF0) < 0.01) voice.f0 = voice.targetF0;
        }

        // Vibrato fades in after the delay.
        voice.noteAge += 1;
        voice.vibPhase += vibRate / sr;
        if (voice.vibPhase >= 1) voice.vibPhase -= 1;
        const vibAge = clamp(voice.noteAge / vibDelaySamples, 0, 1);
        const vibCents = Math.sin(2 * Math.PI * voice.vibPhase) * vibDepth * vibAge;
        const f0 = voice.f0 * Math.pow(2, vibCents / 1200);

        // Formant control rate: every 24 samples, glide the coefficients.
        controlTick -= 1;
        if (controlTick <= 0) {
          controlTick = 24;
          for (const activeVoice of this.voices) {
            if (activeVoice.active) this.computeFormants(activeVoice, this.morphValue(activeVoice));
          }
        }

        // Source: saw↔pulse mix + breath noise (deterministic LCG).
        voice.phase += f0 / sr;
        if (voice.phase >= 1) voice.phase -= 1;
        const saw = voice.phase * 2 - 1;
        const pulseWave = voice.phase < 0.5 ? 1 : -1;
        const source = saw * (1 - pulse) + pulseWave * pulse;
        const breathLevel = voice.breath >= 0 ? voice.breath : breathBase;
        const noise = (this.lcgDraw(voice) * 2 - 1) * breathLevel * 0.4;
        const glottal = source * 0.6 + noise;

        // Three PARALLEL formant bandpasses, each scaled by its band gain.
        let filtered = 0;
        const st = voice.bpState;
        const cf = voice.bpCoef;
        for (let band = 0; band < 3; band++) {
          const c = band * 5;
          const s = band * 4;
          const y =
            cf[c]! * glottal + cf[c + 1]! * st[s]! + cf[c + 2]! * st[s + 1]! - cf[c + 3]! * st[s + 2]! - cf[c + 4]! * st[s + 3]!;
          st[s + 1] = st[s]!;
          st[s] = glottal;
          st[s + 3] = st[s + 2]!;
          st[s + 2] = y;
          filtered += y * (BAND_GAINS[band] ?? 1);
        }

        const voiceSample = filtered * voice.env * voice.vel * voice.gain * level;
        mix += voiceSample;
      }

      left[frame] = mix;
      right[frame] = mix;
      const magnitude = Math.abs(mix);
      if (magnitude > peak) peak = magnitude;
    }
    this.outPeak = peak;
  }

  /** Peak of the last processed block (metering + tests). */
  get lastPeak(): number {
    return this.outPeak;
  }
}
