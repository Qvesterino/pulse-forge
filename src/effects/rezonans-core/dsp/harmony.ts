/**
 * REZONANS — harmony: musical context solver, musical clock, and the voice bus.
 *
 * Three separable concerns, deliberately not fused:
 *
 * 1. **MusicalClock** — owns bar position from an absolute sample counter plus
 *    the tempo changes the host pushes. The chord lane is indexed by ABSOLUTE
 *    integer bar (`ChordEvent.startBar`), so a seek or a loop simply
 *    re-resolves instead of drifting.
 * 2. **HarmonySolver** — turns (detected f0, key, chord, mode) into one pitch
 *    ratio per voice. Pure, allocation-free, and the only place musical policy
 *    lives.
 * 3. **HarmonyBus** — four voices, per-voice overlap-add rings, pan, bus
 *    compensation and width. It knows nothing about keys or chords.
 *
 * Determinism: no RNG. Every voice's "humanise" comes from a hash of the
 * absolute frame counter and the voice index, so it sounds alive and renders
 * bit-identically offline.
 */

import { HarmonyVoice } from "./voice.js";
import { hannWindow } from "./fft.js";

export const HARMONY_VOICE_COUNT = 4;

/** Ratio bounds — ±12 semitones (ADR 0040 decision 7). */
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 2;

/**
 * Restore the mono analysis signal to per-channel unity after equal-power pan.
 * The processor analyses (L + R) / 2 as one voice; a centered equal-power pan
 * writes that voice at 1/√2 to each output. √2 restores the original level,
 * while setBus divides by √(actually active voices) for a stable harmony bus.
 */
export const BUS_UNITY_TRIM = Math.SQRT2;

export type HarmonyMode = "off" | "interval" | "degrees" | "chordTones";

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** MIDI note number for a frequency (69 = A4 = 440 Hz). */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(Math.max(hz, 1e-6) / 440);
}

/** Frequency for a MIDI note number. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Number of allowed pitch classes in a 12-bit mask. */
function maskToneCount(mask: number): number {
  let n = 0;
  for (let i = 0; i < 12; i++) if ((mask & (1 << i)) !== 0) n++;
  return n;
}

/**
 * The n-th allowed pitch class at or above `rootPc`, given a 12-bit mask.
 * `degree 0` is the root, `degree 1` the next allowed tone above it, and so on.
 *
 * Degrees WRAP instead of running out. This is load-bearing: every scale in
 * the project model has 5 or 7 tones, so a 0..14 degree range would leave
 * degrees 7..14 (the octave and above — the most musical choices a user makes)
 * resolving to "no tone", which the caller degrades to unison. A user asking
 * for the octave would get a doubled unison and no explanation. Wrapping makes
 * degree 7 of a heptatonic scale degree 0, and the caller's nearest-instance
 * search puts it where the ear expects it.
 *
 * Returns -1 only when the mask allows nothing at all.
 */
export function nthScaleTone(mask: number, rootPc: number, degree: number): number {
  if (mask === 0 || degree < 0) return -1;
  const tones = maskToneCount(mask);
  if (tones === 0) return -1;
  const wrapped = Math.round(degree) % tones;
  let count = 0;
  for (let i = 0; i < 12; i++) {
    const pc = (((rootPc + i) % 12) + 12) % 12;
    if ((mask & (1 << pc)) !== 0) {
      if (count === wrapped) return pc;
      count++;
    }
  }
  return -1;
}

/** Pitch class nearest `pc` that the mask allows (ties resolve downward). */
export function nearestAllowedPc(mask: number, pc: number): number {
  if (mask === 0) return pc;
  for (let d = 0; d <= 6; d++) {
    const up = (pc + d) % 12;
    if ((mask & (1 << up)) !== 0) return up;
    const down = (((pc - d) % 12) + 12) % 12;
    if ((mask & (1 << down)) !== 0) return down;
  }
  return pc;
}

export interface HarmonyContext {
  keyRootPc: number;
  scaleMask: number;
  chordMask: number;
  chordFollow: number;
  mode: HarmonyMode;
  /** Per-voice target: semitones (interval) or scale degree (degrees/chord). */
  degree: Float64Array;
}

/**
 * Musical clock: bars from a sample counter, driven by pushed tempo changes.
 *
 * Deliberately NOT the project's Transport. An effect that asks the transport
 * for position would break the offline path (the renderer replays tempo per
 * window and never calls `onTransportStarted`), so REZONANS integrates its own
 * counter — the same deterministic approach MORPH uses for its grain phases.
 */
export class MusicalClock {
  private sampleRate = 48000;
  private bpm = 120;
  private beats = 0;
  private pending: { whenSec: number; bpm: number }[] = [];
  private seeded = false;

  prepare(sampleRate: number, bpm: number): void {
    this.sampleRate = sampleRate;
    this.bpm = bpm > 0 ? bpm : 120;
    this.beats = 0;
    this.pending.length = 0;
    this.seeded = false;
  }

  /** Seed absolute musical position (beats from the start of the song). */
  seed(positionBeats: number): void {
    this.beats = Number.isFinite(positionBeats) ? positionBeats : 0;
    this.seeded = true;
  }

  /** Schedule a tempo change at an absolute context time. */
  syncBpm(bpm: number, whenSec: number): void {
    if (!(bpm > 0)) return;
    const when = Number.isFinite(whenSec) ? whenSec : 0;
    if (when <= 0) {
      this.bpm = bpm;
      this.pending.length = 0;
      return;
    }
    const q = this.pending;
    if (q.length >= 64) return; // pathological host input must not grow the scan
    let i = q.length;
    while (i > 0 && q[i - 1]!.whenSec > when) i--;
    q.splice(i, 0, { whenSec: when, bpm });
  }

  /** Advance by a rendered block. `nowSec` is the context time at block start. */
  advance(samples: number, nowSec: number): void {
    while (this.pending.length > 0 && this.pending[0]!.whenSec <= nowSec) {
      this.bpm = this.pending.shift()!.bpm;
    }
    if (!Number.isFinite(samples) || samples <= 0) return;
    this.beats += (samples / this.sampleRate) * (this.bpm / 60);
  }

  get bar(): number {
    return this.beats / 4;
  }

  get positionBeats(): number {
    return this.beats;
  }

  get tempo(): number {
    return this.bpm;
  }

  get isSeeded(): boolean {
    return this.seeded;
  }

  reset(): void {
    this.beats = 0;
    this.pending.length = 0;
    this.seeded = false;
  }
}

export interface ChordLaneEntry {
  startBar: number;
  lengthBars: number;
  rootPc: number;
  chordMask: number;
}

/** Four-voice overlap-add bus with per-voice pan, width and gain compensation. */
export class HarmonyBus {
  private voices: HarmonyVoice[] = [];
  private rings: Float32Array[] = [];
  private winRing = new Float32Array(0);
  private window: Float32Array = new Float32Array(0);
  private ringMask = 0;
  private hop = 512;
  private outPos = 0;
  private readPos = 0;
  private started = false;

  private levels = new Float64Array(HARMONY_VOICE_COUNT);
  private panL = new Float64Array(HARMONY_VOICE_COUNT);
  private panR = new Float64Array(HARMONY_VOICE_COUNT);
  private gains = new Float64Array(HARMONY_VOICE_COUNT);
  /** Skip never-enabled voices; once used, keep their streaming phase state warm. */
  private voiceEverActive = new Uint8Array(HARMONY_VOICE_COUNT);

  private busGain = 0;
  private busGainTarget = 0;
  private widthSm = 1;
  private widthTarget = 1;
  private sideState = 0;
  private hpCoef = 0;

  prepare(sampleRate: number, fftSize: number, hop: number): void {
    this.hop = hop;
    let ringLen = 1;
    while (ringLen < fftSize * 2) ringLen <<= 1;
    this.ringMask = ringLen - 1;
    this.winRing = new Float32Array(ringLen);
    this.window = hannWindow(fftSize);
    this.hpCoef = Math.exp((-2 * Math.PI * 150) / sampleRate);

    for (let i = 0; i < HARMONY_VOICE_COUNT; i++) {
      if (!this.voices[i]) {
        this.voices[i] = new HarmonyVoice();
      }
      // A quality change can resize the OLA ring after voices already exist.
      // Keep each voice ring in lockstep with ringMask: otherwise a Fine-tier
      // frame writes past the old Balanced-tier array and adds `undefined`,
      // which poisons the wet output with NaN.
      if (!this.rings[i] || this.rings[i]!.length !== ringLen) {
        this.rings[i] = new Float32Array(ringLen);
      }
      this.voices[i]!.prepare(fftSize, hop, sampleRate);
      this.rings[i]!.fill(0);
      this.gains[i] = 0;
      this.voiceEverActive[i] = 0;
    }
    this.winRing.fill(0);
    this.outPos = 0;
    this.readPos = 0;
    this.started = false;
    for (let i = 0; i < HARMONY_VOICE_COUNT; i++) this.voices[i]!.reset();
  }

  setVoiceTargets(i: number, ratio: number, alpha: number, level: number, pan: number, spread: number): void {
    const v = this.voices[i];
    if (!v) return;
    v.setTargets(ratio, alpha);
    const eff = clamp(pan * spread, -1, 1);
    const theta = ((eff + 1) * Math.PI) / 4;
    this.panL[i] = Math.cos(theta);
    this.panR[i] = Math.sin(theta);
    this.levels[i] = Math.max(0, Math.min(1.5, level));
    if (this.levels[i]! > 0.0005) this.voiceEverActive[i] = 1;
  }

  setBus(mix: number, width: number): void {
    let activeVoices = 0;
    for (let i = 0; i < HARMONY_VOICE_COUNT; i++) if (this.levels[i]! > 0.0005) activeVoices++;
    this.busGainTarget = (mix * BUS_UNITY_TRIM) / Math.sqrt(Math.max(1, activeVoices));
    this.widthTarget = clamp(width, 0, 2);
  }

  /**
   * Render one synthesis frame into every voice's ring.
   * Called when FrameEngine reports a hop boundary.
   */
  renderFrame(
    mag: Float64Array,
    phase: Float64Array,
    prevPhase: Float64Array,
    envLin: Float64Array,
    logEnv: Float64Array,
  ): void {
    // Frame-rate smoothing: the bus gain and width move once per hop, which is
    // ~10.7 ms — smooth enough for automation and free of per-sample cost.
    const smooth = 1 - Math.exp(-this.hop / (0.03 * 48000));
    this.busGain += (this.busGainTarget - this.busGain) * smooth;
    this.widthSm += (this.widthTarget - this.widthSm) * smooth;
    if (this.busGain < 1e-7) this.busGain = 0;
    if (Math.abs(this.widthSm - 1) < 1e-6) this.widthSm = 1;

    // The window sum is written ONCE per frame, here — never per voice.
    //
    // Every voice shares the synthesis hop and therefore the same window
    // normalisation, so accumulating `win²` inside the voice loop would make
    // the normaliser divide by the ACTIVE VOICE COUNT: four voices would each
    // be normalised by 4× the energy they wrote, and the whole harmony bus
    // would sit 12 dB low. Measured before this was hoisted.
    const win = this.window;
    for (let i = 0; i < win.length; i++) {
      const pos = (this.outPos + i) & this.ringMask;
      const w = win[i]!;
      this.winRing[pos] = this.winRing[pos]! + w * w;
    }

    for (let i = 0; i < HARMONY_VOICE_COUNT; i++) {
      if (!this.voiceEverActive[i]) continue;
      this.voices[i]!.renderFrame(mag, phase, prevPhase, envLin, logEnv, this.rings[i]!, this.outPos, this.ringMask);
    }
    this.outPos = (this.outPos + this.hop) & this.ringMask;
    this.started = true;
  }

  /** Read one output sample pair (L, R), clearing the consumed slots. */
  read(out: { l: number; r: number }): void {
    out.l = 0;
    out.r = 0;
    if (!this.started) return;

    const w = this.winRing[this.readPos]!;
    if (w > 1e-9) {
      const norm = 1 / w;
      let l = 0;
      let r = 0;
      for (let i = 0; i < HARMONY_VOICE_COUNT; i++) {
        const g = this.gains[i]!;
        if (g <= 1e-6) continue;
        const s = this.rings[i]![this.readPos]! * norm * g;
        l += s * this.panL[i]!;
        r += s * this.panR[i]!;
      }
      const g = this.busGain;
      if (g > 1e-7) {
        let ol = l * g;
        let or = r * g;
        if (this.widthSm !== 1) {
          const mid = 0.5 * (ol + or);
          // Side high-passed at 150 Hz: width must never destabilise the low
          // end (same rule MORPH's harmony bus uses).
          const sideIn = 0.5 * (ol - or);
          this.sideState += (sideIn - this.sideState) * (1 - this.hpCoef);
          const side = (sideIn - this.sideState) * this.widthSm;
          ol = mid + side;
          or = mid - side;
        }
        out.l = ol;
        out.r = or;
      }
    }

    // Consume: clear the slots so the next frame can overwrite them.
    for (let i = 0; i < HARMONY_VOICE_COUNT; i++) this.rings[i]![this.readPos] = 0;
    this.winRing[this.readPos] = 0;
    this.readPos = (this.readPos + 1) & this.ringMask;
  }

  setVoiceGain(i: number, g: number): void {
    this.gains[i] = Math.max(0, g);
  }

  reset(): void {
    for (let i = 0; i < HARMONY_VOICE_COUNT; i++) {
      this.rings[i]?.fill(0);
      this.voices[i]?.reset();
      this.gains[i] = 0;
    }
    this.winRing.fill(0);
    this.outPos = 0;
    this.readPos = 0;
    this.started = false;
    this.busGain = 0;
    this.busGainTarget = 0;
    this.widthSm = 1;
    this.widthTarget = 1;
    this.sideState = 0;
    this.voiceEverActive.fill(0);
  }
}

/** Deterministic 0..1 hash of a frame counter + voice index (no RNG state). */
export function humanizeOffset(frame: number, voice: number): number {
  let h = (frame * 374761393 + voice * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Smooth deterministic pitch drift for one harmony voice. A new hashed anchor
 * every eight analysis frames avoids both random worklet state and the stepped
 * "MIDI chorus" sound of changing cents independently on every hop.
 */
export function humanizeCents(frame: number, voice: number, amount: number): number {
  const strength = clamp(amount, 0, 1);
  if (strength === 0) return 0;
  const position = Math.max(0, Number.isFinite(frame) ? frame : 0) / 8;
  const anchor = Math.floor(position);
  const blend = position - anchor;
  const a = humanizeOffset(anchor, voice) * 2 - 1;
  const b = humanizeOffset(anchor + 1, voice) * 2 - 1;
  return (a + (b - a) * blend) * 15 * strength;
}
