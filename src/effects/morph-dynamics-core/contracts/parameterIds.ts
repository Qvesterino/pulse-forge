/**
 * MORPH DYNAMICS — Stable Parameter IDs
 *
 * MORPH DYNAMICS is a dynamics-driven morph processor: incoming audio
 * behavior (transient / body / texture energy, gain reduction, density)
 * becomes the control system that drives dynamics, character, motion and
 * space processing. "Your sound becomes the modulator."
 *
 * ID rules (persistent API contract):
 *   1. IDs are dot-namespaced: global.*, macro.*, analysis.*, dyn.*,
 *      char.*, motion.*, space.*, harm.*, routes.*.
 *   2. Once shipped, an ID never changes meaning. New parameters get new
 *      IDs; removed parameters are deprecated, never renumbered.
 *   3. Modulation routes live in the numeric param map as 8 fixed slots
 *      ("routes.N.*", N = 0..7) so they serialize, automate and clamp
 *      exactly like every other parameter.
 *   4. Meter values are NOT parameters.
 */

// ── Global (I/O, mix, quality) ─────────────────────────────

export const GLOBAL_INPUT_GAIN_DB_ID = "global.inputGainDb" as const;
export const GLOBAL_OUTPUT_GAIN_DB_ID = "global.outputGainDb" as const;
export const GLOBAL_MIX_ID = "global.mix" as const;
/** 0 = eco, 1 = normal, 2 = high (analysis resolution; no DSP character change). */
export const GLOBAL_QUALITY_ID = "global.quality" as const;
/** Delta listen: output = wet − dry (hear only what the processor changes). */
export const GLOBAL_DELTA_ID = "global.delta" as const;

// ── Primary macros (the product surface) ───────────────────
// PRESSURE scales the depth of REACTIVE transformation (curated, nonlinear
// per subsystem). PUNCH is bipolar (attack treatment). BODY / TEXTURE /
// MOTION / SPACE are unipolar intensities of their stage's transformation.

export const MACRO_PRESSURE_ID = "macro.pressure" as const; // 0..100
export const MACRO_PUNCH_ID = "macro.punch" as const; // -100..100
export const MACRO_BODY_ID = "macro.body" as const; // 0..100
export const MACRO_TEXTURE_ID = "macro.texture" as const; // 0..100
export const MACRO_MOTION_ID = "macro.motion" as const; // 0..100
export const MACRO_SPACE_ID = "macro.space" as const; // 0..100

// ── Reactive analysis (source sensitivity) ─────────────────

export const ANALYSIS_TRANSIENT_SENSITIVITY_ID = "analysis.transientSensitivity" as const; // 0..200 %
export const ANALYSIS_BODY_SENSITIVITY_ID = "analysis.bodySensitivity" as const; // 0..200 %
export const ANALYSIS_TEXTURE_SENSITIVITY_ID = "analysis.textureSensitivity" as const; // 0..200 %
/** Adaptive level reference on the analysis tap (AGC) — T/B/T react to
 * PERFORMANCE, not recording level. 0 = fixed reference (legacy). */
export const ANALYSIS_ADAPTIVE_LEVEL_ID = "analysis.adaptiveLevel" as const;

// ── Dynamics engine ─────────────────────────────────────────

export const DYN_THRESHOLD_DB_ID = "dyn.thresholdDb" as const;
export const DYN_RATIO_ID = "dyn.ratio" as const;
export const DYN_ATTACK_MS_ID = "dyn.attackMs" as const;
export const DYN_RELEASE_MS_ID = "dyn.releaseMs" as const;
export const DYN_KNEE_DB_ID = "dyn.kneeDb" as const;
/** 0 = peak … 100 = RMS detector blend. */
export const DYN_DETECTOR_BLEND_ID = "dyn.detectorBlend" as const;
export const DYN_SIDECHAIN_HPF_HZ_ID = "dyn.sidechainHpfHz" as const;
/** External sidechain: detector AND analysis tap follow the sidechain feed
 * (setSidechainInput) instead of the main signal — kick/vocal chop drives
 * the ducking while the main audio stays in place. */
export const DYN_SIDECHAIN_EXT_ID = "dyn.sidechainExt" as const;
export const DYN_MAKEUP_DB_ID = "dyn.makeupDb" as const;
export const DYN_MAKEUP_AUTO_ID = "dyn.makeupAuto" as const;

// ── Character (nonlinear stage) ────────────────────────────

export const CHAR_ENABLED_ID = "char.enabled" as const;
export const CHAR_DRIVE_ID = "char.drive" as const; // 0..100
export const CHAR_TONE_ID = "char.tone" as const; // -100..100 tilt
export const CHAR_ASYM_ID = "char.asym" as const; // 0..100 asymmetric harmonics
export const CHAR_CLIP_ID = "char.clip" as const; // 0..100 soft clip

// ── Motion (all-pass movement) ─────────────────────────────

export const MOTION_ENABLED_ID = "motion.enabled" as const;
export const MOTION_DEPTH_ID = "motion.depth" as const; // 0..100
export const MOTION_RATE_HZ_ID = "motion.rateHz" as const; // 0..5 (secondary drift)
export const MOTION_FEEDBACK_ID = "motion.feedback" as const; // -80..80 %
export const MOTION_CENTER_HZ_ID = "motion.centerHz" as const; // 200..4000

// ── Space (reactive ambience + width) ──────────────────────

export const SPACE_ENABLED_ID = "space.enabled" as const;
export const SPACE_SEND_ID = "space.send" as const; // 0..100
export const SPACE_PREDELAY_MS_ID = "space.predelayMs" as const; // 0..80
export const SPACE_DIFFUSION_ID = "space.diffusion" as const; // 0..100
export const SPACE_DECAY_S_ID = "space.decayS" as const; // 0.1..5
export const SPACE_DAMPING_ID = "space.damping" as const; // 0..100
export const SPACE_WIDTH_ID = "space.width" as const; // 0..200 %
/** Depth of transient-ducked space (signature: clear attack → bloom). */
export const SPACE_DUCK_ID = "space.duck" as const; // 0..100

// ── BODY Harmonizer (Experiment #1) ─────────────────────────
// Harmony is built ONLY from the tonal body component; transients and
// texture pass the chain untouched (see "MORPH DYNAMICS — EXPERIMENT #1
// BODY HARMONIZER.md"). The module is OFF by default — enabling it must
// never silently alter existing MORPH behavior or presets.

export const HARM_ENABLED_ID = "harm.enabled" as const;
/** Level of the ORIGINAL body in the output (0..100). 100 = dry untouched
 * (harmony is a pure parallel add); lower values duck the sustained body
 * to make room for the harmony instead of double-counting body energy. */
export const HARM_BODY_AMOUNT_ID = "harm.bodyAmount" as const;
export const HARM_MIX_ID = "harm.mix" as const; // 0..100 harmony bus level
/** Experiment A/B: 1 = naive FULL-signal harmonization (mask forced to 1)
 * for sonic comparison against BODY-only. Dev/reference, not a product
 * surface. */
export const HARM_DEV_FULL_SIGNAL_ID = "harm.devFullSignal" as const;

// ── Spatial Bloom (Experiment #3, Phase III) ────────────────
// The spatial stage lives on the HARMONY BUS only (the dry signal stays
// the perceptual anchor). Depths are driven THROUGH the modulation
// matrix (Bloom source → the four harm.* destinations below) and scaled
// by the harm.bloom macro — nothing is hardcoded into the DSP.
// Defaults are the IDENTITY: spread 100 (voices at their pan positions),
// width 100 (M/S passthrough), diffusion 0, space 0, bloom 0 (the macro
// gates all spatial modulation depth) — existing sessions are unchanged.

export const HARM_BLOOM_ID = "harm.bloom" as const; // 0..100 spatial macro
/** Voice spread scale, 0..200 % (100 = voices at their pan positions). */
export const HARM_SPREAD_ID = "harm.spread" as const;
/** Harmony-bus stereo width (M/S side gain), 0..200 % (100 = identity). */
export const HARM_WIDTH_ID = "harm.width" as const;
/** Allpass diffusion blend on the harmony bus, 0..100 %. */
export const HARM_DIFFUSION_ID = "harm.diffusion" as const;
/** Harmony space send (bus-only micro reverb return), 0..100 %. */
export const HARM_SPACE_ID = "harm.space" as const;

export const HARM_VOICE_COUNT = 4;

export type HarmVoiceParam = "on" | "interval" | "level" | "pan" | "detune";

export function harmVoiceParamId(voice: number, param: HarmVoiceParam): string {
  return `harm.voice.${voice}.${param}`;
}

/** True for any id inside the harm.voice.N.* namespace (bounded check). */
export function isHarmVoiceParamId(id: string): boolean {
  if (!id.startsWith("harm.voice.")) return false;
  const rest = id.slice("harm.voice.".length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return false;
  const voice = Number.parseInt(rest.slice(0, dot), 10);
  return Number.isInteger(voice) && voice >= 0 && voice < HARM_VOICE_COUNT;
}

// ── Modulation matrix (8 fixed route slots) ────────────────

export const ROUTE_COUNT = 8;

export function routeParamId(slot: number, param: string): string {
  return `routes.${slot}.${param}`;
}

/** True for any id inside the routes.N.* namespace (bounded slot check). */
export function isRouteParamId(id: string): boolean {
  if (!id.startsWith("routes.")) return false;
  const slot = Number.parseInt(id.slice("routes.".length), 10);
  return Number.isInteger(slot) && slot >= 0 && slot < ROUTE_COUNT;
}
