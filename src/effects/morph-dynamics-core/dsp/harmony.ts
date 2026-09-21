/**
 * MORPH DYNAMICS — BODY Harmonizer (Experiments #1 + #3).
 *
 * Harmonizes ONLY the tonal BODY component of the signal (see
 * "MORPH DYNAMICS — EXPERIMENT #1 BODY HARMONIZER.md"): the transient and
 * texture parts of the input pass through the MORPH chain untouched while
 * up to four pitch-shifted harmony voices are built from the sustained
 * tonal mass and recombined in parallel.
 *
 * PHASE III — SPATIAL BLOOM ("MORPH DYNAMICS — PHASE III SPATIAL BLOOM"):
 * the harmony bus feeds a restrained spatial stage — voice spread, stereo
 * width (mono-safe side), diffusion (allpass cohesion, NOT reverb) and a
 * small send-return space. Every stage operates ONLY on the harmony bus;
 * the dry signal stays the untouched perceptual anchor and transients
 * never enter it (the mask gates the feed, so focus comes first and
 * expansion second). All spatial depths arrive as plain parameters from
 * the processor, where they are driven THROUGH the modulation matrix
 * (Bloom source → spread/width/diffusion/space destinations, scaled by the
 * harm.bloom macro) — nothing here reads analysis scores directly.
 *
 * Architecture (smallest decomposition that preserves the existing
 * T/B/T model — the FeatureExtractor produces CONTROL SCORES, not audio,
 * so this module derives its own phase-transparent audio mask):
 *
 *   input ─┬─ dry-body duck (1 − (1−bodyAmount)·mask) ─────────┐
 *          │                                                   ├─→ out
 *          └─ band-shape ─→ mask ─→ grain voices ─→ HARMONY ──┘
 *                            (mono feed)      │ spread · width ·
 *                                             │ diffusion · space
 *                                             └─ (bus-only, dry anchor
 *                                                untouched)
 *
 * BODY extraction is deliberately time-domain and phase-transparent: the
 * mask is a TIME-VARYING GAIN (sustained-ness = slow/fast envelope ratio,
 * level-gated), so the "body signal" never needs to be reconstructed and
 * the dry path cannot comb against it. The granular engine never reads the
 * future (grains are pinned to end at the write line), which makes the
 * whole module ZERO ALGORITHMIC LATENCY — getLatencySamples stays owned by
 * the character halfband and no parallel-path delay is required for
 * recombination. The inherent granular read wobble (≤ one grain) lands
 * only on sustained material, which is exactly why BODY-only
 * harmonization stays transient-clean where full-signal shifting flams.
 *
 * Spatial safety (Phase III §11–13): M/S width is applied with the side
 * channel high-passed at 150 Hz (no low-frequency stereo expansion); the
 * harmony feed itself is band-limited to 110 Hz–3.2 kHz so sub content is
 * never spatialized at all; diffusion is phase-only (allpass — no level
 * decorrelation, mono sum passes through the same network); the space
 * network's comb feedback is hard-bounded below oscillation. Spatial
 * defaults are the IDENTITY (spread 100 %, width 100 %, diffusion 0,
 * space 0) and each stage branches around itself at identity, so a
 * Phase-I/II session renders bit-identically with the spatial code
 * present. Layered response timing (§9): spread ~40 ms, width ~60 ms,
 * diffusion ~90 ms, space ~140 ms per-sample poles on top of the
 * processor's per-route smoothing.
 *
 * Gain staging at the source (Experiment #1 §8): per-voice level, a
 * smoothed 1/√nActive bus compensation, unity-gain allpass networks and a
 * fixed sub-unity space return; the module adds no limiting — the chain's
 * existing soft ceiling remains the last resort.
 *
 * Formant seam (Experiment #1 §5): the ONLY place pitch is decided is
 * HarmonyVoice.setParams → ratio. A future formant stage wraps the grain
 * read inside HarmonyVoice.render() without touching mask, bus or
 * spatial stages.
 *
 * Real-time safety: no allocation after prepare(); deterministic (grain
 * phases derive from an absolute sample counter, never random); every
 * parameter change is either latched at a grain boundary (interval,
 * detune) or faded by a per-sample one-pole (level, pan, mix, spatial
 * depths, enable) — no clicks, no zipper, no unstable states.
 */

import { EnvelopeFollower, OnePoleHP, OnePoleLP, tcToCoef } from "./dspUtils.js";

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
  /** −1..+1 (constant-power pan at spread 100 %). */
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
  /** Voice spread scale, 0..2 (1 = voices at their panned positions — the
   * Phase I/II behavior and the default; 0 = all voices centered; >1 =
   * pushed outward, clamped at the speakers). */
  spread: number;
  /** Harmony-bus stereo width (M/S side gain), 0..2 (1 = identity). */
  width: number;
  /** Allpass diffusion blend on the bus, 0..1 (0 = discrete voices). */
  diffusion: number;
  /** Harmony space send, 0..1 (send-return micro reverb). */
  space: number;
  voices: HarmonyVoiceParams[];
}

interface VoiceConfig {
  ratio: number;
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
 * write line, so no read ever crosses it. Panning is applied by the
 * harmonizer (the spread stage owns stereo position). */
class HarmonyVoice {
  // Targets (host-facing) vs latched values (audio-facing).
  private cfg: VoiceConfig = { ratio: 1, level: 0, enabled: false };
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
   * Render one MONO grain sample of this voice from the shared buffer.
   * `a` is the absolute write counter (sample index since prepare),
   * `writePos` its ring-free value, `h` the half-grain hop, `bufLen`/
   * `bufMask` the ring geometry. Stereo position is applied by the
   * harmonizer's spread stage, not here.
   */
  render(a: number, writePos: number, h: number, buf: Float32Array, bufLen: number): number {
    const target = this.cfg.enabled ? this.cfg.level : 0;
    this.gain += (target - this.gain) * (1 - this.gainCoef);
    if (this.gain < 1e-6 && target === 0) {
      // Keep the grain latch current even while silent so re-enabling
      // starts coherent with the present grain grid.
      this.lastGrain = Math.floor(a / h);
      return 0;
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
    return wet * norm * this.gain;
  }
}

// ── Spatial Bloom building blocks (Phase III) ───────────────────────
// Same comb/allpass primitives as the Space stage (space.ts), scaled for
// a bus-level, sub-unity, hard-bounded network. Lengths are NOT
// power-of-two — wraps use plain compare/adjust, never a mask.

interface CombState {
  buf: Float32Array;
  write: number;
  dampState: number;
  dampCoef: number;
  gain: number;
}

interface ApState {
  buf: Float32Array;
  write: number;
  g: number;
}

/** Hard recirculation bound (same headroom philosophy as SpaceStage). */
const MAX_COMB_GAIN = 0.88;
// Micro space network: 3 damping combs (mono, shared) + 2 allpasses.
const SPACE_COMB_MS = [29.3, 37.7, 43.1];
const SPACE_AP_MS = [5.1, 7.7];
// Diffusion: two series allpasses — phase-only cohesion, identical on
// both channels so the mono sum passes through the SAME network (no
// cancellation by construction).
const DIFF_AP_MS = [5.9, 8.7];

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
  // Voice pan positions: voicePan is the −1..+1 POSITION (spread scales
  // it toward/away from center, clamped at the speakers — extrapolating
  // the constant-power pair past ±1 would leak anti-phase content into
  // the opposite channel); panL/panR is the precomputed pair at spread
  // 100 % for the identity fast path.
  private voicePan = new Array<number>(HARM_VOICE_COUNT).fill(0);
  private panL = new Array<number>(HARM_VOICE_COUNT).fill(0.7071);
  private panR = new Array<number>(HARM_VOICE_COUNT).fill(0.7071);

  // ── Smoothed bus state ──────────────────────────────────────────
  private mixGain = 0; // harmony bus gain (mix × 1/√n) — per-sample pole
  private dryGain = 1; // dry-body duck gain
  private mixCoef = 1;
  // Layered spatial response poles (Phase III §9): faster up front,
  // slower as the cloud deepens — one universal envelope would feel
  // mechanical, so each stage owns its TC (constants, not user-facing V0).
  private spreadSm = 1; // identity at start — no Phase III startup move
  private widthSm = 1;
  private diffSm = 0;
  private spaceSm = 0;
  private spreadCoef = 1;
  private widthCoef = 1;
  private diffCoef = 1;
  private spaceCoef = 1;
  // Width side-channel HP (§13: low frequencies stay centered).
  private sideHP = new OnePoleHP();

  // ── Diffusion network (2 series allpasses, phase-only) — separate
  // state per channel with identical specs, so each channel passes
  // through the same filter independently (sharing one state would
  // interleave L/R into a single line). Phase-only → mono-safe by
  // construction: the mono sum goes through the same rotation. ──────
  private diffApL: ApState[] = [];
  private diffApR: ApState[] = [];

  // ── Micro space send/return ─────────────────────────────────────
  private spaceCombs: CombState[] = [];
  private spaceAp: ApState[] = [];
  private spaceTailQuiet = true;

  private cfg: BodyHarmonizerParams = {
    enabled: false,
    bodyAmount: 1,
    mix: 0.5,
    fullSignal: false,
    spread: 1,
    width: 1,
    diffusion: 0,
    space: 0,
    voices: Array.from({ length: HARM_VOICE_COUNT }, () => ({
      enabled: false,
      interval: 0,
      detune: 0,
      level: 0.7,
      pan: 0,
    })),
  };
  private sampleRate = 48000;

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
    // Layered spatial TCs (§9): harmony mix responds fastest, the cloud
    // closes slowest.
    this.spreadCoef = tcToCoef(0.04, sampleRate);
    this.widthCoef = tcToCoef(0.06, sampleRate);
    this.diffCoef = tcToCoef(0.09, sampleRate);
    this.spaceCoef = tcToCoef(0.14, sampleRate);
    this.sideHP.setFreq(150, sampleRate);
    this.diffApL = DIFF_AP_MS.map((ms) => this.makeAp(ms));
    this.diffApR = DIFF_AP_MS.map((ms) => this.makeAp(ms));
    this.spaceCombs = SPACE_COMB_MS.map((ms) => this.makeComb(ms));
    this.spaceAp = SPACE_AP_MS.map((ms) => this.makeAp(ms));
    // Space decay: a SHORT, controlled field (Experiment #3 §14 — not a
    // giant tail). Fixed t60 ≈ 1.1 s, damped combs, gains hard-bounded.
    for (const c of this.spaceCombs) {
      const lenSec = c.buf.length / sampleRate;
      c.gain = Math.min(MAX_COMB_GAIN, Math.pow(10, (-3 * lenSec) / 1.1));
      c.dampCoef = tcToCoef(0.2, sampleRate);
    }
    for (const ap of this.spaceAp) ap.g = 0.62;
    this.writePos = 0;
    this.mixGain = 0;
    this.dryGain = 1;
    this.spreadSm = 1;
    this.widthSm = 1;
    this.diffSm = 0;
    this.spaceSm = 0;
    this.spaceTailQuiet = true;
    for (let i = 0; i < HARM_VOICE_COUNT; i++) {
      if (!this.voices[i]) this.voices[i] = new HarmonyVoice();
      // Same defensive fallback as setParams (re-prepare after a short cfg).
      this.voices[i]!.setParams(
        this.cfg.voices?.[i] ?? { enabled: false, interval: 0, detune: 0, level: 0, pan: 0 },
        sampleRate,
      );
      this.applyVoicePan(i, this.cfg.voices?.[i]?.pan ?? 0);
      this.voices[i]!.reset();
    }
  }

  private makeComb(ms: number): CombState {
    const len = Math.max(4, Math.ceil((this.sampleRate * ms) / 1000));
    return { buf: new Float32Array(len), write: 0, dampState: 0, dampCoef: 0.3, gain: 0.7 };
  }

  private makeAp(ms: number): ApState {
    const len = Math.max(4, Math.ceil((this.sampleRate * ms) / 1000));
    return { buf: new Float32Array(len), write: 0, g: 0.6 };
  }

  private applyVoicePan(i: number, pan: number): void {
    this.voicePan[i] = clamp(pan, -1, 1);
    const theta = (this.voicePan[i] + 1) * (Math.PI / 4);
    this.panL[i] = Math.cos(theta);
    this.panR[i] = Math.sin(theta);
  }

  setParams(cfg: BodyHarmonizerParams): void {
    this.cfg = cfg;
    for (let i = 0; i < HARM_VOICE_COUNT; i++) {
      // Defensive: a short/absent voices array disables the missing slots
      // instead of crashing the render thread.
      const v = cfg.voices[i];
      this.voices[i]!.setParams(v ?? { enabled: false, interval: 0, detune: 0, level: 0, pan: 0 }, this.sampleRate);
      this.applyVoicePan(i, v?.pan ?? 0);
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
    this.spreadSm = 1;
    this.widthSm = 1;
    this.diffSm = 0;
    this.spaceSm = 0;
    this.sideHP.reset();
    this.spaceTailQuiet = true;
    for (const ap of this.diffApL) {
      ap.buf.fill(0);
      ap.write = 0;
    }
    for (const ap of this.diffApR) {
      ap.buf.fill(0);
      ap.write = 0;
    }
    for (const c of this.spaceCombs) {
      c.buf.fill(0);
      c.dampState = 0;
      c.write = 0;
    }
    for (const ap of this.spaceAp) {
      ap.buf.fill(0);
      ap.write = 0;
    }
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
    const a = this.writePos;
    this.writePos++;

    // ── 3. Bus + spatial parameter poles (layered response, §9) ──
    let nActive = 0;
    for (const v of this.voices) if (v.active) nActive++;
    const compTarget = nActive > 0 ? 1 / Math.sqrt(nActive) : 0;
    // The bus pole serves double duty: mix changes AND voice-count
    // compensation both glide (~30 ms) — no zipper, no explosion.
    const busTarget = this.cfg.mix * compTarget;
    this.mixGain += (busTarget - this.mixGain) * (1 - this.mixCoef);
    if (this.mixGain < 1e-9) this.mixGain = 0; // denormal flush
    this.dryGain = 1 - (1 - clamp(this.cfg.bodyAmount, 0, 1)) * mask;
    this.spreadSm += (clamp(this.cfg.spread, 0, 2) - this.spreadSm) * (1 - this.spreadCoef);
    this.widthSm += (clamp(this.cfg.width, 0, 2) - this.widthSm) * (1 - this.widthCoef);
    this.diffSm += (clamp(this.cfg.diffusion, 0, 1) - this.diffSm) * (1 - this.diffCoef);
    this.spaceSm += (clamp(this.cfg.space, 0, 1) - this.spaceSm) * (1 - this.spaceCoef);
    if (this.diffSm < 1e-6) this.diffSm = 0;
    if (this.spaceSm < 1e-6) this.spaceSm = 0;

    // ── 4. Render voices → spread-aware pan sum ──────────────────
    let busL = 0;
    let busR = 0;
    const spread = this.spreadSm;
    if (spread === 1) {
      // Identity fast path (the default): voice pans as configured.
      for (let i = 0; i < HARM_VOICE_COUNT; i++) {
        const s = this.voices[i]!.render(a, this.writePos - 1, this.h, this.buf, this.bufLen);
        busL += s * this.panL[i]!;
        busR += s * this.panR[i]!;
      }
    } else {
      // Spread scales each voice's −1..+1 POSITION (0 = all voices
      // centered, 1 = configured positions, >1 = pushed outward, clamped
      // at the speakers — never extrapolated past them, which would put
      // anti-phase content in the opposite channel). Constant-power law.
      for (let i = 0; i < HARM_VOICE_COUNT; i++) {
        const s = this.voices[i]!.render(a, this.writePos - 1, this.h, this.buf, this.bufLen);
        const eff = clamp(this.voicePan[i]! * spread, -1, 1);
        const theta = (eff + 1) * (Math.PI / 4);
        busL += s * Math.cos(theta);
        busR += s * Math.sin(theta);
      }
    }
    if (this.mixGain <= 1e-6) {
      busL = 0;
      busR = 0;
    }

    // ── 5. Stereo width (M/S on the bus; side HP'd at 150 Hz so width
    //      never destabilizes the low end — §13, no multiband needed:
    //      the harmony feed is already band-limited above 110 Hz) ────
    if (this.widthSm !== 1) {
      const mid = 0.5 * (busL + busR);
      const side = this.sideHP.process(0.5 * (busL - busR)) * this.widthSm;
      busL = mid + side;
      busR = mid - side;
    }

    // ── 6. Diffusion: phase-only allpass cohesion (NOT reverb — §14) ─
    if (this.diffSm > 0) {
      const dL = this.apSeries(this.diffApL, busL);
      const dR = this.apSeries(this.diffApR, busR);
      busL += (dL - busL) * this.diffSm;
      busR += (dR - busR) * this.diffSm;
    }

    // ── 7. Micro space send/return (bus-only — the dry anchor never
    //      enters the network; the tail decays naturally, §9) ────────
    let spaceL = 0;
    let spaceR = 0;
    if (this.spaceSm > 0 || !this.spaceTailQuiet) {
      const send = (busL * 0.5 + busR * 0.5) * this.spaceSm;
      let wet = 0;
      for (const c of this.spaceCombs) wet += this.comb(c, send);
      wet = this.apSeries(this.spaceAp, wet) * 0.5;
      // Mono, damped return added equally to both channels — width comes
      // from the width stage, not from the reverb (stays mono-stable).
      spaceL = wet;
      spaceR = wet;
      this.spaceTailQuiet = this.spaceSm === 0 && Math.abs(wet) < 1e-8;
    }

    out.l = (busL + spaceL) * this.mixGain;
    out.r = (busR + spaceR) * this.mixGain;
    out.dry = this.dryGain;
  }

  private comb(c: CombState, x: number): number {
    const read = c.buf[c.write];
    // One-pole damping inside the feedback loop.
    c.dampState = read + c.dampCoef * (c.dampState - read);
    c.buf[c.write] = x + c.dampState * c.gain;
    c.write += 1;
    if (c.write >= c.buf.length) c.write = 0;
    return read;
  }

  /** Series allpass (both diffusion and space use it). */
  private apSeries(aps: ApState[], x: number): number {
    let y = x;
    for (const ap of aps) {
      const read = ap.buf[ap.write];
      ap.buf[ap.write] = y - ap.g * read;
      y = read + ap.g * ap.buf[ap.write];
      ap.write += 1;
      if (ap.write >= ap.buf.length) ap.write = 0;
    }
    return y;
  }
}

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}
