/**
 * MORPH DYNAMICS — BODY Harmonizer (Experiment #1).
 *
 * Harmonizes ONLY the tonal BODY component of the signal (see
 * "MORPH DYNAMICS — EXPERIMENT #1 BODY HARMONIZER.md"): the transient and
 * texture parts of the input pass through the MORPH chain untouched while
 * up to four pitch-shifted harmony voices are built from the sustained
 * tonal mass and recombined in parallel.
 *
 * Architecture (smallest decomposition that preserves the existing
 * T/B/T model — the FeatureExtractor produces CONTROL SCORES, not audio,
 * so this module derives its own phase-transparent audio mask):
 *
 *   input ─┬─ dry-body duck (1 − (1−bodyAmount)·mask) ──┐
 *          │                                            ├─→ out
 *          └─ band-shape ─→ mask ─→ grain voices ───────┘
 *                            (mono feed, per-voice pan)
 *
 * BODY extraction is deliberately time-domain and phase-transparent: the
 * mask is a TIME-VARYING GAIN (sustained-ness = slow/fast envelope ratio,
 * level-gated), so the "body signal" never needs to be reconstructed and
 * the dry path cannot comb against it. The granular engine never reads the
 * future (grains are pinned to end at the write line), which makes the
 * whole module ZERO ALGORITHMIC LATENCY — getLatencySamples stays owned by
 * the character halfband and no parallel-path delay is required for
 * recombination (§7 of the experiment doc). The inherent granular read
 * wobble (≤ one grain) lands only on sustained material, which is exactly
 * why BODY-only harmonization stays transient-clean where full-signal
 * shifting flams.
 *
 * Gain staging at the source (§8): per-voice level, then a smoothed
 * 1/√nActive bus compensation so enabling more voices trades energy, not
 * loudness; the module adds no limiting — the chain's existing soft ceiling
 * remains the last resort.
 *
 * Formant seam (§5): the ONLY place pitch is decided is
 * HarmonyVoice.setPitch(interval, detune) → ratio. A future formant stage
 * wraps the grain read inside HarmonyVoice.render() (dual-ratio /
 * per-grain spectral envelope) without touching the mask, bus or
 * processor integration.
 *
 * Real-time safety: no allocation after prepare(); deterministic (grain
 * phases derive from an absolute sample counter, never random); every
 * parameter change is either latched at a grain boundary (interval,
 * detune) or faded by a per-sample one-pole (level, pan, mix, enable) —
 * no clicks, no zipper, no unstable states.
 */

import { EnvelopeFollower, OnePoleLP, tcToCoef } from "./dspUtils.js";

export const HARM_VOICE_COUNT = 4;

export interface HarmonyVoiceParams {
  enabled: boolean;
  /** Semitones, −24..+24 (the experiment's useful range is ±12; the
   * architecture is not artificially limited). */
  interval: number;
  /** Fine detune in cents, −50..+50. */
  detune: number;
  /** Linear voice level, 0..1.5. */
  level: number;
  /** −1..+1 (constant-power pan). */
  pan: number;
}

export interface BodyHarmonizerParams {
  enabled: boolean;
  /** How much of the ORIGINAL body survives in the output, 0..1.
   * 1 = dry untouched (harmony is a pure add — the default), lower values
   * duck the sustained body to make room and avoid double-counting body
   * energy when the harmony sits in. */
  bodyAmount: number;
  /** Harmony bus level, 0..1. */
  mix: number;
  /** Experiment A/B (§14): when true the mask is forced to 1 — the module
   * becomes a NAIVE FULL-SIGNAL harmonizer for comparison. Not user-facing
   * product behavior. */
  fullSignal: boolean;
  voices: HarmonyVoiceParams[];
}

interface ImmutableVoiceConfig {
  ratio: number;
  panL: number;
  panR: number;
  level: number;
  enabled: boolean;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** One harmony voice: a granular dual-grain (50 % overlap, Hann — COLA)
 * pitch shifter over the SHARED body ring buffer. Port of the proven
 * design in src/audio-worklets/pitchshift-processor.js (the hardened COLA
 * rewrite): grains read only the PAST at `ratio`, pinned to end at the
 * write line, so no read ever crosses it. */
class HarmonyVoice {
  // Targets (host-facing) vs latched values (audio-facing).
  private cfg: ImmutableVoiceConfig = { ratio: 1, panL: 0.7071, panR: 0.7071, level: 0, enabled: false };
  // Gain fades per sample (level × enable — one pole, ~12 ms).
  private gain = 0;
  private gainCoef = 1;
  // Per-GRAIN ratio latch: a grain keeps the ratio it was BORN with for its
  // whole 2h life; the live target only applies to grains starting now.
  // Latching globally would bend the read slope of the still-sounding
  // previous grain mid-window — an instant read-position jump of up to
  // h·Δratio samples, i.e. an audible click on every interval change.
  private grainRatios = [1, 1];
  private lastGrain = -1;

  setParams(p: HarmonyVoiceParams, sampleRate: number): void {
    const semis = clamp(p.interval, -24, 24) + clamp(p.detune, -50, 50) / 100;
    this.cfg.ratio = Math.pow(2, semis / 12);
    const theta = ((clamp(p.pan, -1, 1) + 1) * Math.PI) / 4;
    this.cfg.panL = Math.cos(theta);
    this.cfg.panR = Math.sin(theta);
    this.cfg.level = clamp(p.level, 0, 1.5);
    this.cfg.enabled = p.enabled;
    this.gainCoef = tcToCoef(0.012, sampleRate);
  }

  get active(): boolean {
    return this.cfg.enabled && this.cfg.level > 0.0005;
  }

  reset(): void {
    this.gain = 0;
    this.grainRatios[0] = this.cfg.ratio;
    this.grainRatios[1] = this.cfg.ratio;
    this.lastGrain = -1;
  }

  /**
   * Render one sample of this voice from the shared buffer. `a` is the
   * absolute write counter (sample index since prepare), `writePos` its
   * ring-free value, `h` the half-grain hop, `bufLen`/`bufMask` the ring
   * geometry. Returns the PANNED mono grain pair into outL/outR.
   */
  render(
    a: number,
    writePos: number,
    h: number,
    buf: Float32Array,
    bufLen: number,
    out: { l: number; r: number },
  ): void {
    const target = this.cfg.enabled ? this.cfg.level : 0;
    this.gain += (target - this.gain) * (1 - this.gainCoef);
    if (this.gain < 1e-6 && target === 0) {
      out.l = 0;
      out.r = 0;
      // Keep the grain latch current even while silent so re-enabling
      // starts coherent with the present grain grid.
      this.lastGrain = Math.floor(a / h);
      return;
    }
    const k = Math.floor(a / h);
    if (k !== this.lastGrain) {
      // Stamp the CURRENT target onto every grain starting now (normally
      // exactly one; per-sample stepping never skips a boundary).
      this.grainRatios[k & 1] = this.cfg.ratio;
      this.lastGrain = k;
    }

    let wet = 0;
    let windowSum = 0;
    for (let g = k; g >= k - 1; g--) {
      const u = a / h - g; // 0..2 within this grain
      if (u < 0 || u > 2) continue;
      const window = 0.5 * (1 - Math.cos(Math.PI * u));
      const ratio = this.grainRatios[g & 1];
      const grainStart = g * h;
      // Shift-up grains start BEHIND the grain start so the read (which
      // advances at `ratio`) ends exactly at the write line — the past-only
      // invariant that keeps this engine zero-latency.
      const base = ratio >= 1 ? grainStart + 2 * h * (1 - ratio) : grainStart;
      const read = base + (a - grainStart) * ratio;
      if (read < 0 || read > writePos) continue;
      let p = read % bufLen;
      if (p < 0) p += bufLen;
      const i0 = Math.floor(p);
      const frac = p - i0;
      const i1 = i0 + 1 === bufLen ? 0 : i0 + 1;
      wet += (buf[i0] * (1 - frac) + buf[i1] * frac) * window;
      windowSum += window;
    }
    const norm = windowSum > 1e-6 ? 1 / windowSum : 0;
    const s = wet * norm * this.gain;
    out.l = s * this.cfg.panL;
    out.r = s * this.cfg.panR;
  }
}

export class BodyHarmonizer {
  // ── Body mask (the audio-rate T/B/T decomposition) ──────────────
  private lpToneHi = new OnePoleLP(); // 3.2 kHz — drops hiss/cymbal air
  private lpToneLo = new OnePoleLP(); // 110 Hz — drops sub rumble
  private lpNois = new OnePoleLP(); // 2 kHz — HF split for the noise gate
  private fastEnv = new EnvelopeFollower(); // ~2 ms — transient edge
  private slowEnv = new EnvelopeFollower(); // ~60 ms — sustained mass
  private noisEnv = new EnvelopeFollower(); // HF component envelope
  private toneEnv = new EnvelopeFollower(); // full-band envelope (matched pair)
  private presenceEnv = new EnvelopeFollower(); // ~25 ms release — audio presence gate
  private maskEnv = new EnvelopeFollower(); // the smoothed mask itself

  // ── Grain engine (shared ring buffer, mono body feed) ───────────
  private voices: HarmonyVoice[] = [];
  private buf = new Float32Array(0);
  private bufLen = 0;
  private bufMask = 0;
  private writePos = 0; // absolute sample counter (determinism)
  private h = 1; // half-grain hop (samples)

  // ── Smoothed bus state ──────────────────────────────────────────
  private mixGain = 0; // harmony bus gain (mix × 1/√n) — per-sample pole
  private dryGain = 1; // dry-body duck gain
  private mixCoef = 1;
  private cfg: BodyHarmonizerParams = {
    enabled: false,
    bodyAmount: 1,
    mix: 0.5,
    fullSignal: false,
    voices: Array.from({ length: HARM_VOICE_COUNT }, () => ({
      enabled: false,
      interval: 0,
      detune: 0,
      level: 0.7,
      pan: 0,
    })),
  };
  private sampleRate = 48000;

  // Scratch for voice renders (no per-sample allocation).
  private vout = { l: 0, r: 0 };

  prepare(sampleRate: number): void {
    this.sampleRate = sampleRate;
    // 50 ms grain (h = 25 ms): long enough for stable low voices,
    // short enough that ±12 stays intelligible on vocal bodies.
    this.h = Math.max(64, Math.round(0.025 * sampleRate));
    let len = 4096;
    while (len < 4 * this.h + 128) len *= 2;
    if (len !== this.bufLen) {
      this.buf = new Float32Array(len);
      this.bufLen = len;
    }
    this.buf.fill(0);
    this.bufMask = len - 1;
    this.lpToneHi.setFreq(3200, sampleRate);
    this.lpToneLo.setFreq(110, sampleRate);
    this.lpNois.setFreq(2000, sampleRate);
    // The sustained-ness pair share the SAME release (300 ms) and differ
    // ONLY in attack (2 ms vs 60 ms). With mismatched releases the ratio
    // slow/fast climbs back toward 1 while an event is still ringing out
    // (fast decays first), reopening the mask behind every strike; equal
    // releases make the ratio freeze at its strike-time value until the
    // gate — not the ratio — decides the tail is over.
    this.fastEnv.setTimes(0.002, 0.3, sampleRate);
    this.slowEnv.setTimes(0.06, 0.3, sampleRate);
    // The noisiness pair is matched too (2 ms / 50 ms, so the HF SHARE is
    // level- and decay-invariant): clicks, consonants and cymbal texture
    // carry most of their band energy above 2 kHz; held tonal material
    // almost none. This is the gate that catches a QUIET transient over a
    // LOUD sustain — the ratio view cannot see it (nothing rises), but its
    // spectrum gives it away.
    this.noisEnv.setTimes(0.002, 0.05, sampleRate);
    this.toneEnv.setTimes(0.002, 0.05, sampleRate);
    // Mask: blooms over ~40 ms of sustained tone, slams shut in ~2 ms when
    // any of its views drops — the asymmetry IS the transient/body split.
    this.maskEnv.setTimes(0.04, 0.002, sampleRate);
    // Presence gate: closes within ~40 ms of the audio stopping so the mask
    // never sits open across a gap and leaks the NEXT transient's onset
    // into the grain engine (a zero-latency mask cannot close before a
    // transient it has not seen — it must simply never be pre-opened).
    this.presenceEnv.setTimes(0.002, 0.025, sampleRate);
    this.mixCoef = tcToCoef(0.03, sampleRate);
    this.writePos = 0;
    this.mixGain = 0;
    this.dryGain = 1;
    for (let i = 0; i < HARM_VOICE_COUNT; i++) {
      if (!this.voices[i]) this.voices[i] = new HarmonyVoice();
      // Same defensive fallback as setParams (re-prepare after a short cfg).
      this.voices[i]!.setParams(
        this.cfg.voices?.[i] ?? { enabled: false, interval: 0, detune: 0, level: 0, pan: 0 },
        sampleRate,
      );
      this.voices[i]!.reset();
    }
  }

  setParams(cfg: BodyHarmonizerParams): void {
    this.cfg = cfg;
    for (let i = 0; i < HARM_VOICE_COUNT; i++) {
      // Defensive: a short/absent voices array disables the missing slots
      // instead of crashing the render thread.
      const v = cfg.voices[i];
      this.voices[i]!.setParams(v ?? { enabled: false, interval: 0, detune: 0, level: 0, pan: 0 }, this.sampleRate);
    }
  }

  /** The current body mask (observability / tests). */
  getMask(): number {
    return this.maskEnv.value;
  }

  reset(): void {
    this.buf.fill(0);
    this.writePos = 0;
    this.lpToneHi.reset();
    this.lpToneLo.reset();
    this.lpNois.reset();
    this.fastEnv.reset();
    this.slowEnv.reset();
    this.noisEnv.reset();
    this.toneEnv.reset();
    this.presenceEnv.reset();
    this.maskEnv.reset();
    this.mixGain = 0;
    this.dryGain = 1;
    for (const v of this.voices) v.reset();
  }

  /**
   * Process one interleaved stereo frame of the POST-INPUT-GAIN tap.
   * Writes the harmony bus into `out` and the dry-body duck gain into
   * `outDry` (multiply the audible wet path by it BEFORE adding the bus).
   * When the module is disabled this must not be called — the processor
   * skips it entirely (bit-exact bypass).
   */
  processFrame(l: number, r: number, out: { l: number; r: number; dry: number }): void {
    const mono = 0.5 * (l + r);

    // ── 1. Tonal body feed + mask ────────────────────────────────
    const tone = this.lpToneHi.process(mono) - this.lpToneLo.process(mono);
    const absTone = Math.abs(tone);
    const fastV = this.fastEnv.processAbs(absTone);
    const slowV = this.slowEnv.processAbs(absTone);
    const presenceV = this.presenceEnv.processAbs(absTone);
    // HF share (matched envelopes → decay-invariant): the noisiness view.
    const noisV = this.noisEnv.processAbs(Math.abs(tone - this.lpNois.process(tone)));
    const toneV = this.toneEnv.processAbs(absTone);
    let rawMask: number;
    if (this.cfg.fullSignal) {
      rawMask = 1; // experiment arm A: naive full-signal harmonization
    } else {
      // Sustained-ness: when the slow mass matches the fast edge the tone
      // is being HELD (mask → 1); a strike makes fast spike ahead (→ 0).
      const w = fastV > 1e-9 ? clamp(slowV / fastV, 0, 1) : 0;
      // Noisiness: broadband content (clicks, consonants, cymbals) is
      // pushed out of the harmony even when the ratio view misses it.
      const hfShare = toneV > 1e-9 ? clamp(noisV / toneV, 0, 1) : 0;
      const hfGate = 1 - smooth01((hfShare - 0.35) / 0.3);
      // Presence gate: only LIVE tonal material harmonizes — noise floors,
      // gap tails and post-click silence never pre-open the mask.
      const gate = smooth01((presenceV - 3e-3) / 1.2e-2);
      rawMask = w * hfGate * gate;
    }
    const mask = this.maskEnv.processAbs(rawMask);

    // ── 2. Feed the granular engine (mono tonal body × mask) ─────
    this.buf[this.writePos & this.bufMask] = tone * mask;
    this.writePos++;

    // ── 3. Bus management: gain staging at the source (§8) ──────
    let nActive = 0;
    for (const v of this.voices) if (v.active) nActive++;
    const compTarget = nActive > 0 ? 1 / Math.sqrt(nActive) : 0;
    // The bus pole serves double duty: mix changes AND voice-count
    // compensation both glide (~30 ms) — no zipper, no explosion.
    const busTarget = this.cfg.mix * compTarget;
    this.mixGain += (busTarget - this.mixGain) * (1 - this.mixCoef);
    if (this.mixGain < 1e-9) this.mixGain = 0; // denormal flush
    this.dryGain = 1 - (1 - clamp(this.cfg.bodyAmount, 0, 1)) * mask;

    // ── 4. Render voices ─────────────────────────────────────────
    let busL = 0;
    let busR = 0;
    if (this.mixGain > 1e-6) {
      for (const v of this.voices) {
        v.render(this.writePos - 1, this.writePos - 1, this.h, this.buf, this.bufLen, this.vout);
        busL += this.vout.l;
        busR += this.vout.r;
      }
    } else {
      // Keep voice state (grain latches, gain poles) advancing cheaply.
      for (const v of this.voices) {
        v.render(this.writePos - 1, this.writePos - 1, this.h, this.buf, this.bufLen, this.vout);
      }
      busL = 0;
      busR = 0;
    }

    out.l = busL * this.mixGain;
    out.r = busR * this.mixGain;
    out.dry = this.dryGain;
  }
}

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}
