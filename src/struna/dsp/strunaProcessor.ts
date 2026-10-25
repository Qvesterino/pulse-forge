/**
 * STRUNA DSP core (ADR 0061) — extended Karplus-Strong.
 *
 * One note = one string: a delay line of one period, excited by an LCG
 * noise burst shaped by a pick-position comb and a sharpness pre-emphasis,
 * then looped through a one-pole damping filter with pitch-consistent loop
 * gain ρ = exp(−ln(1000)/(decaySec·f0)) — the −60 dB time is DECAY at any
 * pitch. noteOff steepens the damping (palm mute over RELEASE).
 *
 * MPE: `polyPressure` (breath-style `bright` live events) overrides the
 * loop brightness per note; `polyTimbre` (`pick` events) overrides the
 * pick position — both update the running string in place, no re-attack.
 *
 * Deterministic: the excitation burst draws from a per-note LCG seeded at
 * noteOn (pitch + counter) — live and offline identical given the same
 * events (the `processorOptions.events` seed). Bounded: 8 voices, delay
 * lines ≤ 2400 samples (pitches ≥ ~28 Hz), zero allocation in the render
 * path.
 */

export interface StrunaEvent {
  type: "noteOn" | "noteOff" | "panic" | "bright" | "pick";
  /** Absolute context time in seconds. */
  when: number;
  pitch?: number;
  velocity?: number;
  /** Live override value 0..1 (bright: loop openness; pick: comb position). */
  value?: number;
}

export interface StrunaInitOptions {
  sampleRate: number;
  events?: StrunaEvent[];
}

const MAX_VOICES = 8;
/** Delay-line ceiling: MIDI 24 (32.7 Hz) at 48 kHz ≈ 1468 samples + margin. */
const DELAY_MAX = 2600;

interface Voice {
  active: boolean;
  gate: boolean;
  basePitch: number;
  vel: number;
  age: number;
  /** The string buffer and its length (one period at the played pitch). */
  line: Float32Array;
  lineLen: number;
  read: number;
  write: number;
  /** Loop damping ρ and the one-pole LP state. */
  rho: number;
  lpCoef: number;
  lp: number;
  /** Mute damping multiplier applied on noteOff. */
  muteRho: number;
  /** Pick comb position and sharpness captured at noteOn. */
  pickPos: number;
  pickSharp: number;
  /** Body resonances: 2 biquads × [x1, x2, y1, y2] + coef [b0,b1,b2,a1,a2]. */
  bodyState: Float32Array;
  bodyCoef: Float32Array;
  /** Remaining true-decay samples before the mute floor takes over. */
  energy: number;
  /** Excitation LCG (seeded at noteOn). */
  lcg: number;
  /** DC blocker (5 Hz one-pole) on the stream output. */
  dcState: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Two guitar-cavity resonances (~105/210 Hz) as RBJ peaking biquads. */
function bodyCoeffs(out: Float32Array, sr: number, toneScale: number): void {
  const pairs: Array<[number, number, number]> = [
    [105 * toneScale, 1.4, 8],
    [210 * toneScale, 1.8, 6],
  ];
  for (let b = 0; b < 2; b++) {
    const [fc, A, q] = pairs[b]!;
    const w = (2 * Math.PI * clamp(fc, 40, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha / A;
    const c = b * 5;
    out[c] = (1 + alpha * A) / a0;
    out[c + 1] = (-2 * cw) / a0;
    out[c + 2] = (1 - alpha * A) / a0;
    out[c + 3] = (-2 * cw) / a0;
    out[c + 4] = (1 - alpha / A) / a0;
  }
}

export class StrunaProcessor {
  private sampleRate: number;
  private params: Record<string, number> = {};
  private events: StrunaEvent[] = [];
  private voices: Voice[] = [];
  private voiceCounter = 0;
  private blockEvents: StrunaEvent[] = [];
  private outPeak = 0;

  constructor(options: StrunaInitOptions) {
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 48000;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        gate: false,
        basePitch: 60,
        vel: 0.8,
        age: 0,
        line: new Float32Array(DELAY_MAX),
        lineLen: 480,
        read: 0,
        write: 0,
        rho: 0.999,
        lpCoef: 0.3,
        lp: 0,
        muteRho: 1,
        pickPos: 0.25,
        pickSharp: 0.4,
        bodyState: new Float32Array(8),
        bodyCoef: new Float32Array(10),
        energy: 0,
        lcg: 1,
        dcState: 0,
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

  postEvent(event: StrunaEvent): void {
    if (!Number.isFinite(event.when)) return;
    this.events.push(event);
    for (let i = this.events.length - 1; i > 0 && this.events[i - 1]!.when > event.when; i--) {
      const tmp = this.events[i - 1]!;
      this.events[i - 1] = this.events[i]!;
      this.events[i] = tmp;
    }
  }

  private noteOn(pitch: number, velocity: number): void {
    if (!Number.isFinite(pitch)) return;
    let voice = this.voices.find((candidate) => !candidate.active);
    if (!voice) voice = this.voices.reduce((oldest, c) => (c.age < oldest.age ? c : oldest));
    const f0 = clamp(midiToHz(pitch), 28, this.sampleRate * 0.4);
    voice.active = true;
    voice.gate = true;
    voice.basePitch = pitch;
    voice.vel = clamp(velocity, 0, 1);
    voice.age = ++this.voiceCounter;
    voice.lineLen = Math.max(16, Math.min(DELAY_MAX, Math.round(this.sampleRate / f0)));
    voice.read = 0;
    voice.write = 0;
    voice.energy = 0;
    voice.pickPos = clamp(this.params.pickPos ?? 0.25, 0.02, 1);
    voice.pickSharp = clamp(this.params.pickSharp ?? 0.4, 0, 1);
    voice.lcg = (0x9e3779b9 ^ Math.imul(pitch + 1, 2654435761) ^ Math.imul(this.voiceCounter, 40503)) >>> 0;
    voice.dcState = 0;

    // ρ is PER SAMPLE: the loop damps once per sample (not once per period),
    // so ρ = exp(−ln(1000)/(decaySec·sr)) puts −60 dB at decaySec seconds
    // for ANY pitch. The old per-period formula decayed a note in ~5 ms
    // (measured — the pitch spec caught it).
    const decaySec = clamp(this.params.decay ?? 2.2, 0.3, 8);
    voice.rho = Math.exp(-Math.log(1000) / Math.max(1, decaySec * this.sampleRate));
    voice.muteRho = 1;
    // Brightness: the initial one-pole LP inside the loop (0 = dark round,
    // 1 = bright with the damping one-pole barely engaged).
    // DAMP → the loop LP coefficient: 0 = bright long ring, 1 = dark fast
    // death. The brightness MPE override re-derives it live.
    const damp = clamp(this.params.damp ?? 0.35, 0, 1);
    // The loop one-pole is the string's tone control: 0.06 ≈ 460 Hz (dark,
    // nylon), 0.36 ≈ 2.9 kHz (bright steel). The default sits at a pluck.
    voice.lpCoef = 0.06 + (1 - damp) * 0.3;
    voice.lp = 0;

    // Excitation: one period of shaped noise, comb-filtered at the pick
    // position, sharpness = first-difference mix (the pick's edge).
    voice.line.fill(0);
    const burst = Math.min(voice.lineLen, DELAY_MAX - 1);
    for (let i = 0; i < burst; i++) {
      let s = this.lcgDraw(voice) * 2 - 1;
      s += (this.lcgDraw(voice) * 2 - 1 - s) * voice.pickSharp; // pre-emphasis
      const combAt = Math.floor(i - voice.pickPos * voice.lineLen);
      const combIdx = ((combAt % voice.lineLen) + voice.lineLen) % voice.lineLen;
      voice.line[combIdx] = (voice.line[combIdx]! + s) * 0.7;
      voice.line[i % voice.lineLen] = (voice.line[i % voice.lineLen]! + s) * 0.7;
    }

    const toneScale = clamp(this.params.bodyTone ?? 1, 0.5, 2);
    bodyCoeffs(voice.bodyCoef, this.sampleRate, toneScale);
    voice.bodyState.fill(0);
  }

  private noteOff(): void {
    // Palm mute: every gated string's loop gain drops over RELEASE.
    const muteSec = clamp(this.params.mute ?? 0.25, 0.02, 1);
    for (const voice of this.voices) {
      if (voice.active && voice.gate) {
        const f0 = this.sampleRate / Math.max(16, voice.lineLen);
        voice.muteRho = Math.exp(-Math.log(1000) / Math.max(1, (muteSec * this.sampleRate) / Math.max(1, f0)));
        voice.gate = false;
      }
    }
  }

  applyEvent(event: StrunaEvent): void {
    switch (event.type) {
      case "noteOn":
        this.noteOn(event.pitch ?? 60, event.velocity ?? 0.8);
        break;
      case "noteOff":
        this.noteOff();
        break;
      case "bright": {
        const value = Number.isFinite(event.value) ? clamp(event.value as number, 0, 1) : null;
        if (value === null) break;
        for (const voice of this.voices) {
          if (voice.active && voice.gate) {
            // Live brightness: re-derive the loop LP (press = brighter).
            voice.lpCoef = 0.06 + value * 0.3;
          }
        }
        break;
      }
      case "pick": {
        const value = Number.isFinite(event.value) ? clamp(event.value as number, 0.02, 1) : null;
        if (value === null) break;
        for (const voice of this.voices) {
          if (voice.active && voice.gate) voice.pickPos = value;
        }
        break;
      }
      case "panic":
        for (const voice of this.voices) {
          voice.active = false;
          voice.gate = false;
          voice.energy = 0;
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

    const level = clamp(this.params.level ?? 0.85, 0, 1.5) * 0.9;
    const drive = clamp(this.params.drive ?? 0.1, 0, 1);
    const bodyLevel = clamp(this.params.bodyLevel ?? 0.3, 0, 1);

    left.fill(0);
    right.fill(0);
    let peak = 0;

    for (let frame = 0; frame < frames; frame++) {
      const frameTime = (currentFrame + frame) / sr;
      while (eventCursor < blockEvents.length && blockEvents[eventCursor]!.when <= frameTime) {
        this.applyEvent(blockEvents[eventCursor]!);
        eventCursor += 1;
      }

      let mix = 0;
      for (const voice of this.voices) {
        if (!voice.active) continue;

        // KS loop with the TEXTBOOK damping: the two-point average has a
        // null at Nyquist, so the broadband excitation decays INTO the
        // string's modes within the first loop pass — my first one-pole
        // (cutoff ~2900 Hz, applied per sample) let the noise circulate at
        // nearly full level for the whole decay (measured: 3120 zero
        // crossings/s — noise, not a note).
        const out = voice.line[voice.read]!;
        const next = voice.line[(voice.read + 1) % voice.lineLen]!;
        const avg = 0.5 * (out + next);
        const damped = voice.lp + voice.lpCoef * (avg - voice.lp);
        voice.lp = damped;
        voice.line[voice.read] = damped * voice.rho * voice.muteRho;
        voice.read = (voice.read + 1) % voice.lineLen;

        // DC blocker (5 Hz one-pole): the loop's DC mode decays with ρ like
        // everything else, but the blocker keeps the OUTPUT centered so
        // crossings stay clean (the classic KS one-sided drift, measured).
        voice.dcState += 0.00066 * (out - voice.dcState);
        let sample = out - voice.dcState;
        if (drive > 0) sample = Math.tanh(sample * (1 + drive * 2)) / Math.tanh(1 + drive * 2);

        // Body: the direct string plus two cavity resonances on a copy.
        if (bodyLevel > 0) {
          const st = voice.bodyState;
          const cf = voice.bodyCoef;
          let body = sample;
          for (let b = 0; b < 2; b++) {
            const c = b * 5;
            const s = b * 4;
            const y =
              cf[c]! * body +
              cf[c + 1]! * st[s]! +
              cf[c + 2]! * st[s + 1]! -
              cf[c + 3]! * st[s + 2]! -
              cf[c + 4]! * st[s + 3]!;
            st[s + 1] = st[s]!;
            st[s] = body;
            st[s + 3] = st[s + 2]!;
            st[s + 2] = y;
            body = y;
          }
          sample += (body - sample) * bodyLevel * 0.5 + sample;
        }

        mix += sample * voice.vel;

        // String death: the loop's peak output below −80 dB counts as
        // silent; require a few quiet samples via the energy accumulator.
        voice.energy = Math.max(voice.energy * 0.9995, Math.abs(out));
        if (!voice.gate && voice.energy < 5e-4) {
          voice.active = false;
          voice.energy = 0;
          continue;
        }
      }

      mix *= level;
      if (drive > 0) mix = Math.tanh(mix);
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
