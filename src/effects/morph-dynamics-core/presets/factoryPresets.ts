/**
 * MORPH DYNAMICS — Factory presets.
 *
 * A preset is a reusable answer to "when this sound behaves this way, how
 * should the processor respond?" — it encodes REACTIVE BEHAVIOR (macro
 * positions + analysis sensitivity + modulation routes), not just knob
 * positions. Every factory preset here demonstrates at least one reactive
 * relationship that a static multi-FX could not produce.
 *
 * The first 8 are the GOLDEN PRESETS (PRESET_SYSTEM.md §21): regression
 * references rendered by tests/morph-dynamics-golden.test.ts after
 * significant DSP changes. Do not renumber them.
 */

import { buildDefaultParams, clampParam, PARAM_BY_ID } from "../contracts/parameterSchema.js";

export const MORPH_PRESET_SCHEMA_VERSION = 1;

export type MorphPresetSource = "vocal" | "drums" | "bass" | "synth" | "instrument" | "bus" | "creative";

export type MorphPresetIntensity = "subtle" | "moderate" | "strong" | "extreme";

export interface MorphFactoryPreset {
  id: string;
  name: string;
  category: MorphPresetSource;
  /** Functional intent (Clean / Punch / Dense / Motion / Space / Extreme…). */
  intent: string;
  intensity: MorphPresetIntensity;
  description: string;
  /** Overrides merged onto buildDefaultParams(); clamped on apply. */
  params: Record<string, number>;
}

/** Golden preset ids — ordered regression references. */
export const GOLDEN_PRESET_IDS = [
  "morph-clean-vocal-control",
  "morph-dense-vocal",
  "morph-drum-bus-pressure",
  "morph-smash-bloom",
  "morph-solid-bass",
  "morph-reactive-synth",
  "morph-subtle-bus-glue",
  "morph-extreme-creative",
] as const;

/**
 * SCENE presets — factory presets written directly for the app-native
 * genres (drill / phonk / jersey / dnb). Surfaced as their own group at
 * the top of the panel's preset list so the user's material is one click
 * away, not buried under source categories.
 */
export const SCENE_PRESET_IDS = [
  "morph-drill-bus-pressure",
  "morph-phonk-808-weight",
  "morph-jersey-vocal-bark",
  "morph-dnb-punch-glue",
] as const;

const R = {
  enabled: (slot: number) => `routes.${slot}.enabled`,
  source: (slot: number) => `routes.${slot}.source`,
  dest: (slot: number) => `routes.${slot}.destination`,
  amount: (slot: number) => `routes.${slot}.amount`,
  smooth: (slot: number) => `routes.${slot}.smoothMs`,
} as const;

/** BODY Harmonizer voice param helpers (Experiment #1 presets). */
const HV = (voice: number, param: "on" | "interval" | "level" | "pan" | "detune") => `harm.voice.${voice}.${param}`;

// SOURCE index: 0 inputEnergy · 1 gainReduction · 2 transient · 3 body ·
// 4 texture · 5 density · 6 pressure
// DEST index:   0 compThr · 1 compRatio · 2 drive · 3 tone · 4 clip ·
// 5 motionDepth · 6 motionRate · 7 motionFb · 8 spaceSend · 9 diffusion ·
// 10 decay · 11 width

function preset(
  id: string,
  name: string,
  category: MorphPresetSource,
  intent: string,
  intensity: MorphPresetIntensity,
  description: string,
  params: Record<string, number>,
): MorphFactoryPreset {
  return { id, name, category, intent, intensity, description, params };
}

export const FACTORY_PRESETS: readonly MorphFactoryPreset[] = [
  // ── GOLDEN 1 ────────────────────────────────────────────────
  preset(
    "morph-clean-vocal-control",
    "Clean Vocal Control",
    "vocal",
    "Clean",
    "moderate",
    "Serious vocal dynamics, consonants protected. Transients duck space; body quietly feeds drive as the performance lifts.",
    {
      "macro.pressure": 30,
      "macro.punch": 35,
      "macro.body": 45,
      "macro.texture": 40,
      "macro.motion": 0,
      "macro.space": 20,
      "dyn.thresholdDb": -22,
      "dyn.ratio": 2.8,
      "dyn.attackMs": 8,
      "dyn.releaseMs": 140,
      "dyn.kneeDb": 8,
      "analysis.transientSensitivity": 130,
      "space.send": 18,
      "space.duck": 70,
      [R.enabled(0)]: 1,
      [R.source(0)]: 2, // Transient
      [R.dest(0)]: 8, // → Space Send
      [R.amount(0)]: -55,
      [R.enabled(1)]: 1,
      [R.source(1)]: 3, // Body
      [R.dest(1)]: 2, // → Drive
      [R.amount(1)]: 25,
    },
  ),
  // ── GOLDEN 2 ────────────────────────────────────────────────
  preset(
    "morph-dense-vocal",
    "Dense Lead Vocal",
    "vocal",
    "Dense",
    "strong",
    "The vocal grows denser and more harmonically present as the performance gets louder. Loud phrases thicken, soft phrases stay open.",
    {
      "macro.pressure": 55,
      "macro.punch": 25,
      "macro.body": 65,
      "macro.texture": 45,
      "macro.motion": 10,
      "macro.space": 25,
      "dyn.thresholdDb": -26,
      "dyn.ratio": 3.4,
      "dyn.attackMs": 6,
      "dyn.releaseMs": 120,
      "char.drive": 12,
      "char.asym": 18,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 2, // → Drive
      [R.amount(0)]: 38,
      [R.enabled(1)]: 1,
      [R.source(1)]: 1, // Gain Reduction
      [R.dest(1)]: 4, // → Clip
      [R.amount(1)]: 22,
      [R.enabled(2)]: 1,
      [R.source(2)]: 2, // Transient
      [R.dest(2)]: 8, // → Space Send
      [R.amount(2)]: -45,
      [R.enabled(3)]: 1,
      [R.source(3)]: 4, // Texture
      [R.dest(3)]: 11, // → Width
      [R.amount(3)]: 18,
    },
  ),
  // ── GOLDEN 3 ────────────────────────────────────────────────
  preset(
    "morph-drum-bus-pressure",
    "Drum Bus Pressure",
    "drums",
    "Punch",
    "strong",
    "Glue compression with body-driven saturation and transient-ducked ambience: the hats breathe wide while the kick stays front and dry.",
    {
      "macro.pressure": 60,
      "macro.punch": 40,
      "macro.body": 60,
      "macro.texture": 60,
      "macro.motion": 15,
      "macro.space": 35,
      "dyn.thresholdDb": -20,
      "dyn.ratio": 3,
      "dyn.attackMs": 15,
      "dyn.releaseMs": 160,
      "char.drive": 15,
      "char.clip": 8,
      "space.send": 28,
      "space.duck": 75,
      [R.enabled(0)]: 1,
      [R.source(0)]: 2, // Transient
      [R.dest(0)]: 8, // → Space Send
      [R.amount(0)]: -65,
      [R.enabled(1)]: 1,
      [R.source(1)]: 3, // Body
      [R.dest(1)]: 2, // → Drive
      [R.amount(1)]: 42,
      [R.enabled(2)]: 1,
      [R.source(2)]: 4, // Texture
      [R.dest(2)]: 11, // → Width
      [R.amount(2)]: 44,
    },
  ),
  // ── GOLDEN 4 ────────────────────────────────────────────────
  preset(
    "morph-smash-bloom",
    "Smash & Bloom",
    "drums",
    "Dense",
    "extreme",
    "The signature: every hit smashes into drive and motion, then the ambience blooms wide in the gaps. Sound-design territory.",
    {
      "macro.pressure": 90,
      "macro.punch": 55,
      "macro.body": 70,
      "macro.texture": 70,
      "macro.motion": 55,
      "macro.space": 60,
      "dyn.thresholdDb": -28,
      "dyn.ratio": 5,
      "dyn.attackMs": 4,
      "dyn.releaseMs": 110,
      "char.drive": 30,
      "char.asym": 25,
      "char.clip": 15,
      "motion.depth": 45,
      "motion.rateHz": 0.3,
      "motion.feedback": 45,
      "space.send": 45,
      "space.decayS": 2.2,
      "space.duck": 85,
      [R.enabled(0)]: 1,
      [R.source(0)]: 1, // Gain Reduction
      [R.dest(0)]: 2, // → Drive
      [R.amount(0)]: 60,
      [R.enabled(1)]: 1,
      [R.source(1)]: 2, // Transient
      [R.dest(1)]: 8, // → Space Send
      [R.amount(1)]: -85,
      [R.enabled(2)]: 1,
      [R.source(2)]: 3, // Body
      [R.dest(2)]: 5, // → Motion Depth
      [R.amount(2)]: 55,
      [R.enabled(3)]: 1,
      [R.source(3)]: 4, // Texture
      [R.dest(3)]: 9, // → Diffusion
      [R.amount(3)]: 60,
    },
  ),
  // ── GOLDEN 5 ────────────────────────────────────────────────
  preset(
    "morph-solid-bass",
    "Solid Bass",
    "bass",
    "Dense",
    "moderate",
    "Stable fundamental with energy-tied upper harmonics. Low end stays put; intensity brings growl, never wobble.",
    {
      "macro.pressure": 45,
      "macro.punch": 30,
      "macro.body": 55,
      "macro.texture": 25,
      "macro.motion": 0,
      "macro.space": 0,
      "dyn.thresholdDb": -24,
      "dyn.ratio": 3,
      "dyn.attackMs": 18,
      "dyn.releaseMs": 200,
      "dyn.sidechainHpfHz": 40,
      "char.drive": 10,
      "char.asym": 15,
      "space.width": 100,
      [R.enabled(0)]: 1,
      [R.source(0)]: 0, // Input Energy
      [R.dest(0)]: 2, // → Drive
      [R.amount(0)]: 35,
      [R.enabled(1)]: 1,
      [R.source(1)]: 2, // Transient
      [R.dest(1)]: 0, // → Comp Threshold
      [R.amount(1)]: 40,
    },
  ),
  // ── GOLDEN 6 ────────────────────────────────────────────────
  preset(
    "morph-reactive-synth",
    "Reactive Synth Orbit",
    "synth",
    "Motion",
    "strong",
    "Sustained pads start orbiting as body energy rises; attacks stay dry while texture drifts wide. Static patches become alive.",
    {
      "macro.pressure": 70,
      "macro.punch": 10,
      "macro.body": 45,
      "macro.texture": 55,
      "macro.motion": 60,
      "macro.space": 45,
      "dyn.thresholdDb": -26,
      "dyn.ratio": 2.2,
      "motion.depth": 40,
      "motion.rateHz": 0.15,
      "motion.feedback": 35,
      "space.send": 30,
      "space.decayS": 1.8,
      "space.width": 140,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 5, // → Motion Depth
      [R.amount(0)]: 60,
      [R.enabled(1)]: 1,
      [R.source(1)]: 4, // Texture
      [R.dest(1)]: 11, // → Width
      [R.amount(1)]: 50,
      [R.enabled(2)]: 1,
      [R.source(2)]: 2, // Transient
      [R.dest(2)]: 8, // → Space Send
      [R.amount(2)]: -50,
    },
  ),
  // ── GOLDEN 7 ────────────────────────────────────────────────
  preset(
    "morph-subtle-bus-glue",
    "Subtle Bus Glue",
    "bus",
    "Clean",
    "subtle",
    "Conservative mix-bus cohesion: gentle dynamics, a breath of harmonic lift, mono-safe width. Nothing moves without the music.",
    {
      "macro.pressure": 18,
      "macro.punch": 15,
      "macro.body": 35,
      "macro.texture": 40,
      "macro.motion": 0,
      "macro.space": 15,
      "dyn.thresholdDb": -18,
      "dyn.ratio": 1.8,
      "dyn.attackMs": 25,
      "dyn.releaseMs": 300,
      "dyn.kneeDb": 12,
      "char.drive": 4,
      "space.send": 10,
      "space.duck": 40,
      "space.width": 108,
      [R.enabled(0)]: 1,
      [R.source(0)]: 5, // Density
      [R.dest(0)]: 0, // → Comp Threshold
      [R.amount(0)]: 30,
    },
  ),
  // ── GOLDEN 8 ────────────────────────────────────────────────
  preset(
    "morph-extreme-creative",
    "Extreme Creative",
    "creative",
    "Extreme",
    "extreme",
    "Full-depth reactive morphing: density drives ratio, motion orbits on GR, the tail blooms and collapses with the performance.",
    {
      "macro.pressure": 100,
      "macro.punch": 50,
      "macro.body": 80,
      "macro.texture": 80,
      "macro.motion": 75,
      "macro.space": 70,
      "dyn.thresholdDb": -30,
      "dyn.ratio": 6,
      "dyn.attackMs": 3,
      "dyn.releaseMs": 90,
      "char.drive": 35,
      "char.asym": 35,
      "char.clip": 25,
      "motion.depth": 60,
      "motion.rateHz": 0.8,
      "motion.feedback": 55,
      "space.send": 50,
      "space.predelayMs": 24,
      "space.diffusion": 75,
      "space.decayS": 3,
      "space.duck": 90,
      [R.enabled(0)]: 1,
      [R.source(0)]: 5, // Density
      [R.dest(0)]: 1, // → Comp Ratio
      [R.amount(0)]: 55,
      [R.enabled(1)]: 1,
      [R.source(1)]: 1, // Gain Reduction
      [R.dest(1)]: 5, // → Motion Depth
      [R.amount(1)]: 65,
      [R.enabled(2)]: 1,
      [R.source(2)]: 6, // Pressure
      [R.dest(2)]: 10, // → Decay
      [R.amount(2)]: 50,
      [R.enabled(3)]: 1,
      [R.source(3)]: 2, // Transient
      [R.dest(3)]: 8, // → Space Send
      [R.amount(3)]: -90,
    },
  ),

  // ── Vocal family ────────────────────────────────────────────
  preset(
    "morph-breath-bloom",
    "Breath Bloom",
    "vocal",
    "Space",
    "moderate",
    "Breath and air activate controlled ambience and width; consonants keep the tail polite.",
    {
      "macro.pressure": 40,
      "macro.punch": 20,
      "macro.body": 35,
      "macro.texture": 75,
      "macro.motion": 0,
      "macro.space": 50,
      "analysis.textureSensitivity": 140,
      "space.send": 32,
      "space.diffusion": 70,
      "space.duck": 65,
      [R.enabled(0)]: 1,
      [R.source(0)]: 4, // Texture
      [R.dest(0)]: 9, // → Diffusion
      [R.amount(0)]: 55,
      [R.enabled(1)]: 1,
      [R.source(1)]: 4, // Texture
      [R.dest(1)]: 11, // → Width
      [R.amount(1)]: 45,
      [R.enabled(2)]: 1,
      [R.source(2)]: 2, // Transient
      [R.dest(2)]: 8, // → Space Send
      [R.amount(2)]: -50,
    },
  ),
  preset(
    "morph-aggressive-vocal",
    "Aggressive Vocal",
    "vocal",
    "Aggressive",
    "strong",
    "Forward, compressed, harmonically animated. GR feeds clip so loud phrases bite without smearing consonants.",
    {
      "macro.pressure": 75,
      "macro.punch": 45,
      "macro.body": 70,
      "macro.texture": 35,
      "macro.motion": 15,
      "macro.space": 15,
      "dyn.thresholdDb": -24,
      "dyn.ratio": 4,
      "dyn.attackMs": 3,
      "dyn.releaseMs": 100,
      "char.drive": 22,
      "char.clip": 18,
      "char.tone": 15,
      [R.enabled(0)]: 1,
      [R.source(0)]: 1, // Gain Reduction
      [R.dest(0)]: 4, // → Clip
      [R.amount(0)]: 45,
      [R.enabled(1)]: 1,
      [R.source(1)]: 2, // Transient
      [R.dest(1)]: 2, // → Drive
      [R.amount(1)]: 30,
    },
  ),

  // ── Drums family ────────────────────────────────────────────
  preset(
    "morph-punch-preserve",
    "Punch Preserve",
    "drums",
    "Punch",
    "moderate",
    "Body compression with strong transient protection and a whisper of clip glue. Kick and snare stay untouched up front.",
    {
      "macro.pressure": 35,
      "macro.punch": 70,
      "macro.body": 50,
      "macro.texture": 30,
      "macro.motion": 0,
      "macro.space": 0,
      "dyn.thresholdDb": -20,
      "dyn.ratio": 2.6,
      "dyn.attackMs": 20,
      "dyn.releaseMs": 150,
      "char.clip": 6,
    },
  ),
  preset(
    "morph-hat-texture",
    "Hat Texture",
    "drums",
    "Texture",
    "moderate",
    "High-frequency rhythmic material opens into diffusion and width without any band-splitting logic.",
    {
      "macro.pressure": 50,
      "macro.punch": 20,
      "macro.body": 20,
      "macro.texture": 85,
      "macro.motion": 10,
      "macro.space": 45,
      "analysis.textureSensitivity": 150,
      "space.width": 150,
      "space.duck": 55,
      [R.enabled(0)]: 1,
      [R.source(0)]: 4, // Texture
      [R.dest(0)]: 9, // → Diffusion
      [R.amount(0)]: 60,
      [R.enabled(1)]: 1,
      [R.source(1)]: 4, // Texture
      [R.dest(1)]: 11, // → Width
      [R.amount(1)]: 55,
      [R.enabled(2)]: 1,
      [R.source(2)]: 2, // Transient
      [R.dest(2)]: 10, // → Decay
      [R.amount(2)]: -45,
    },
  ),

  // ── Bass family ─────────────────────────────────────────────
  preset(
    "morph-harmonic-push",
    "Bass Harmonic Push",
    "bass",
    "Aggressive",
    "strong",
    "Performance-sensitive saturation with a stable core — intensity brings harmonics, the fundamental never leaves.",
    {
      "macro.pressure": 60,
      "macro.punch": 35,
      "macro.body": 60,
      "macro.texture": 20,
      "macro.motion": 0,
      "macro.space": 0,
      "dyn.thresholdDb": -22,
      "dyn.ratio": 3.2,
      "char.drive": 18,
      "char.asym": 22,
      "char.tone": 20,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 2, // → Drive
      [R.amount(0)]: 50,
    },
  ),
  preset(
    "morph-reactive-growl",
    "Reactive Growl",
    "bass",
    "Motion",
    "extreme",
    "Creative bass morph: body drives character AND motion above the fundamental. Growls follow the notes.",
    {
      "macro.pressure": 85,
      "macro.punch": 40,
      "macro.body": 80,
      "macro.texture": 30,
      "macro.motion": 55,
      "macro.space": 10,
      "dyn.thresholdDb": -26,
      "dyn.ratio": 4,
      "char.drive": 25,
      "motion.depth": 40,
      "motion.rateHz": 0.6,
      "motion.centerHz": 1400,
      "space.width": 100,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 2, // → Drive
      [R.amount(0)]: 60,
      [R.enabled(1)]: 1,
      [R.source(1)]: 3, // Body
      [R.dest(1)]: 5, // → Motion Depth
      [R.amount(1)]: 55,
    },
  ),

  // ── Synth family ────────────────────────────────────────────
  preset(
    "morph-static-to-alive",
    "Static to Alive",
    "synth",
    "Motion",
    "moderate",
    "Simple sustained patches start breathing: density slowly sweeps motion, no LFO in sight.",
    {
      "macro.pressure": 55,
      "macro.punch": 10,
      "macro.body": 40,
      "macro.texture": 40,
      "macro.motion": 45,
      "macro.space": 25,
      "motion.depth": 30,
      "motion.rateHz": 0.1,
      "motion.feedback": 30,
      [R.enabled(0)]: 1,
      [R.source(0)]: 5, // Density
      [R.dest(0)]: 6, // → Motion Rate
      [R.amount(0)]: 40,
      [R.enabled(1)]: 1,
      [R.source(1)]: 3, // Body
      [R.dest(1)]: 5, // → Motion Depth
      [R.amount(1)]: 45,
    },
  ),
  preset(
    "morph-synth-bloom",
    "Synth Bloom",
    "synth",
    "Space",
    "strong",
    "Rising sustained energy expands harmonic richness and space; releasing notes let the tail settle back.",
    {
      "macro.pressure": 65,
      "macro.punch": 15,
      "macro.body": 55,
      "macro.texture": 60,
      "macro.motion": 20,
      "macro.space": 60,
      "space.send": 38,
      "space.decayS": 2.4,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 10, // → Decay
      [R.amount(0)]: 45,
      [R.enabled(1)]: 1,
      [R.source(1)]: 5, // Density
      [R.dest(1)]: 2, // → Drive
      [R.amount(1)]: 40,
      [R.enabled(2)]: 1,
      [R.source(2)]: 2, // Transient
      [R.dest(2)]: 8, // → Space Send
      [R.amount(2)]: -40,
    },
  ),

  // ── Instrument / bus / creative ─────────────────────────────
  preset(
    "morph-pick-presence",
    "Pick Presence",
    "instrument",
    "Punch",
    "moderate",
    "Guitar and plucked instruments: pick attacks clarify and lift while sustain warms with body energy.",
    {
      "macro.pressure": 45,
      "macro.punch": 60,
      "macro.body": 45,
      "macro.texture": 45,
      "macro.motion": 10,
      "macro.space": 20,
      "dyn.attackMs": 5,
      "char.drive": 12,
      "char.tone": 20,
      [R.enabled(0)]: 1,
      [R.source(0)]: 2, // Transient
      [R.dest(0)]: 3, // → Tone
      [R.amount(0)]: 40,
      [R.enabled(1)]: 1,
      [R.source(1)]: 3, // Body
      [R.dest(1)]: 2, // → Drive
      [R.amount(1)]: 30,
    },
  ),
  preset(
    "morph-cohesion-air",
    "Cohesion + Air",
    "bus",
    "Clean",
    "subtle",
    "Bus stabilization with texture-sensitive air; strict gain control, width only when the material is diffuse.",
    {
      "macro.pressure": 25,
      "macro.punch": 10,
      "macro.body": 45,
      "macro.texture": 55,
      "macro.motion": 0,
      "macro.space": 25,
      "dyn.ratio": 2,
      "dyn.kneeDb": 14,
      "space.send": 14,
      "space.width": 112,
      "space.duck": 45,
      [R.enabled(0)]: 1,
      [R.source(0)]: 4, // Texture
      [R.dest(0)]: 11, // → Width
      [R.amount(0)]: 25,
    },
  ),
  preset(
    "morph-pulse",
    "Pulse",
    "creative",
    "Motion",
    "strong",
    "Rhythmic reactive pulse: density pushes motion rate so busy passages tremolo-shape themselves.",
    {
      "macro.pressure": 75,
      "macro.punch": 25,
      "macro.body": 45,
      "macro.texture": 45,
      "macro.motion": 70,
      "macro.space": 20,
      "motion.depth": 50,
      "motion.rateHz": 0.4,
      [R.enabled(0)]: 1,
      [R.source(0)]: 5, // Density
      [R.dest(0)]: 6, // → Motion Rate
      [R.amount(0)]: 70,
      [R.enabled(1)]: 1,
      [R.source(1)]: 2, // Transient
      [R.dest(1)]: 7, // → Motion Feedback
      [R.amount(1)]: 50,
    },
  ),
  preset(
    "morph-ghost-tail",
    "Ghost Tail",
    "creative",
    "Space",
    "extreme",
    "Quiet passages bloom into a long ghosted tail; anything loud snaps the space shut. Reverses the usual reverb logic.",
    {
      "macro.pressure": 70,
      "macro.punch": 0,
      "macro.body": 35,
      "macro.texture": 70,
      "macro.motion": 15,
      "macro.space": 75,
      "space.send": 45,
      "space.predelayMs": 30,
      "space.decayS": 3.6,
      "space.duck": 95,
      [R.enabled(0)]: 1,
      [R.source(0)]: 0, // Input Energy
      [R.dest(0)]: 8, // → Space Send
      [R.amount(0)]: -70,
      [R.enabled(1)]: 1,
      [R.source(1)]: 4, // Texture
      [R.dest(1)]: 10, // → Decay
      [R.amount(1)]: 55,
    },
  ),
  preset(
    "morph-collapse",
    "Collapse",
    "creative",
    "Extreme",
    "extreme",
    "Loud collapses everything inward (ratio + clip), silence lets it spring back wide and diffuse.",
    {
      "macro.pressure": 95,
      "macro.punch": -30,
      "macro.body": 75,
      "macro.texture": 65,
      "macro.motion": 40,
      "macro.space": 55,
      "dyn.thresholdDb": -28,
      "dyn.ratio": 5,
      "char.drive": 30,
      "char.clip": 30,
      "space.width": 140,
      "space.duck": 80,
      [R.enabled(0)]: 1,
      [R.source(0)]: 0, // Input Energy
      [R.dest(0)]: 1, // → Comp Ratio
      [R.amount(0)]: 60,
      [R.enabled(1)]: 1,
      [R.source(1)]: 1, // Gain Reduction
      [R.dest(1)]: 4, // → Clip
      [R.amount(1)]: 55,
      [R.enabled(2)]: 1,
      [R.source(2)]: 1, // Gain Reduction
      [R.dest(2)]: 11, // → Width
      [R.amount(2)]: -50,
    },
  ),

  // ── Scene presets (drill / phonk / jersey / dnb — app-native genres) ──
  preset(
    "morph-drill-bus-pressure",
    "Drill Bus Pressure",
    "drums",
    "Punch",
    "strong",
    "Drum bus glue tuned for drill: sliding 808s stay glued, hats sizzle wide, and every hit ducks the tail clean.",
    {
      "macro.pressure": 55,
      "macro.punch": 45,
      "macro.body": 55,
      "macro.texture": 65,
      "macro.motion": 0,
      "macro.space": 30,
      "dyn.thresholdDb": -22,
      "dyn.ratio": 3.2,
      "dyn.attackMs": 10,
      "dyn.releaseMs": 130,
      "char.drive": 14,
      "char.tone": -15,
      "space.send": 22,
      "space.duck": 80,
      [R.enabled(0)]: 1,
      [R.source(0)]: 2, // Transient
      [R.dest(0)]: 8, // → Space Send
      [R.amount(0)]: -70,
      [R.enabled(1)]: 1,
      [R.source(1)]: 3, // Body
      [R.dest(1)]: 2, // → Drive
      [R.amount(1)]: 35,
      [R.enabled(2)]: 1,
      [R.source(2)]: 4, // Texture
      [R.dest(2)]: 11, // → Width
      [R.amount(2)]: 50,
    },
  ),
  preset(
    "morph-phonk-808-weight",
    "Phonk 808 Weight",
    "bass",
    "Dense",
    "strong",
    "Cowbell-melody-safe 808 weight: slow-grab density on the sub, growl only when the performance digs in, stereo untouched.",
    {
      "macro.pressure": 55,
      "macro.punch": 20,
      "macro.body": 75,
      "macro.texture": 15,
      "macro.motion": 0,
      "macro.space": 0,
      "dyn.thresholdDb": -26,
      "dyn.ratio": 3.4,
      "dyn.attackMs": 28,
      "dyn.releaseMs": 260,
      "dyn.sidechainHpfHz": 30,
      "dyn.kneeDb": 9,
      "char.drive": 12,
      "char.asym": 20,
      "space.width": 100,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 2, // → Drive
      [R.amount(0)]: 45,
      [R.enabled(1)]: 1,
      [R.source(1)]: 0, // Input Energy
      [R.dest(1)]: 0, // → Comp Threshold
      [R.amount(1)]: 35,
    },
  ),
  preset(
    "morph-jersey-vocal-bark",
    "Jersey Vocal Bark",
    "vocal",
    "Aggressive",
    "strong",
    "Club-vocal bark: GR feeds the clipper so loud phrases bite through, consonants keep a fast transient exit.",
    {
      "macro.pressure": 70,
      "macro.punch": 40,
      "macro.body": 60,
      "macro.texture": 30,
      "macro.motion": 0,
      "macro.space": 10,
      "dyn.thresholdDb": -24,
      "dyn.ratio": 3.6,
      "dyn.attackMs": 2,
      "dyn.releaseMs": 90,
      "char.drive": 18,
      "char.clip": 24,
      "char.tone": 20,
      [R.enabled(0)]: 1,
      [R.source(0)]: 1, // Gain Reduction
      [R.dest(0)]: 4, // → Clip
      [R.amount(0)]: 55,
      [R.enabled(1)]: 1,
      [R.source(1)]: 2, // Transient
      [R.dest(1)]: 3, // → Tone
      [R.amount(1)]: 30,
    },
  ),
  preset(
    "morph-dnb-punch-glue",
    "DnB Punch Glue",
    "drums",
    "Punch",
    "strong",
    "Breakbeat glue with a fast transient exit: the break punches through, the air blooms behind it, nothing smears.",
    {
      "macro.pressure": 60,
      "macro.punch": 55,
      "macro.body": 50,
      "macro.texture": 60,
      "macro.motion": 10,
      "macro.space": 35,
      "dyn.thresholdDb": -20,
      "dyn.ratio": 2.8,
      "dyn.attackMs": 4,
      "dyn.releaseMs": 110,
      "char.drive": 10,
      "char.clip": 8,
      "space.send": 26,
      "space.duck": 85,
      "space.decayS": 1,
      [R.enabled(0)]: 1,
      [R.source(0)]: 2, // Transient
      [R.dest(0)]: 8, // → Space Send
      [R.amount(0)]: -75,
      [R.enabled(1)]: 1,
      [R.source(1)]: 4, // Texture
      [R.dest(1)]: 9, // → Diffusion
      [R.amount(1)]: 45,
      [R.enabled(2)]: 1,
      [R.source(2)]: 3, // Body
      [R.dest(2)]: 2, // → Drive
      [R.amount(2)]: 30,
    },
  ),

  // ── EXPERIMENT #1: BODY HARMONIZER (dev/reference states) ───
  // These encode the harmonizer as the product intends it: harmony grows
  // out of the sustained tonal BODY while attacks pass clean. Each is also
  // a test/reference state for the experiment's A/B validation.
  preset(
    "morph-exp-subtle-vocal-bloom",
    "Subtle Vocal Bloom",
    "vocal",
    "Bloom",
    "subtle",
    "BODY Harmonizer: a quiet +7/+12 bloom rises out of sustained vocal tone — louder, more sustained phrases open more harmony (Body → Harmony Mix route), consonants stay dry.",
    {
      "harm.enabled": 1,
      "harm.bodyAmount": 85,
      "harm.mix": 25,
      [HV(0, "on")]: 1,
      [HV(0, "interval")]: 7,
      [HV(0, "level")]: 55,
      [HV(0, "pan")]: -20,
      [HV(0, "detune")]: -4,
      [HV(1, "on")]: 1,
      [HV(1, "interval")]: 12,
      [HV(1, "level")]: 35,
      [HV(1, "pan")]: 25,
      [HV(1, "detune")]: 3,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 12, // → Harmony Mix
      [R.amount(0)]: 60,
      [R.smooth(0)]: 120,
    },
  ),
  preset(
    "morph-exp-wide-fifths",
    "Wide Fifths",
    "instrument",
    "Bloom",
    "moderate",
    "BODY Harmonizer: parallel fifths (+7/−5) spread hard left/right from the sustained body — pads and leads bloom into a wide stack while picks and attacks stay articulate.",
    {
      "harm.enabled": 1,
      "harm.bodyAmount": 80,
      "harm.mix": 45,
      [HV(0, "on")]: 1,
      [HV(0, "interval")]: 7,
      [HV(0, "level")]: 70,
      [HV(0, "pan")]: -55,
      [HV(1, "on")]: 1,
      [HV(1, "interval")]: -5,
      [HV(1, "level")]: 70,
      [HV(1, "pan")]: 55,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 12, // → Harmony Mix
      [R.amount(0)]: 45,
      [R.smooth(0)]: 90,
    },
  ),
  preset(
    "morph-exp-octave-body",
    "Octave Body",
    "synth",
    "Bloom",
    "moderate",
    "BODY Harmonizer: the sustained body doubles an octave up (bass sub stays put, pluck attacks stay dry) — a one-knob octave-lift that only engages while notes hold.",
    {
      "harm.enabled": 1,
      "harm.bodyAmount": 90,
      "harm.mix": 55,
      [HV(0, "on")]: 1,
      [HV(0, "interval")]: 12,
      [HV(0, "level")]: 75,
      [HV(0, "pan")]: 0,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 12, // → Harmony Mix
      [R.amount(0)]: 35,
      [R.smooth(0)]: 80,
    },
  ),
  preset(
    "morph-exp-synthetic-choir",
    "Synthetic Choir",
    "vocal",
    "Bloom",
    "strong",
    "BODY Harmonizer: +3/+7/+12 with slight detunes build a slow synthetic choir out of sustained vocal tone; sibilance and breath never join the shift.",
    {
      "harm.enabled": 1,
      "harm.bodyAmount": 75,
      "harm.mix": 50,
      [HV(0, "on")]: 1,
      [HV(0, "interval")]: 3,
      [HV(0, "level")]: 60,
      [HV(0, "pan")]: -40,
      [HV(0, "detune")]: 6,
      [HV(1, "on")]: 1,
      [HV(1, "interval")]: 7,
      [HV(1, "level")]: 60,
      [HV(1, "pan")]: 40,
      [HV(1, "detune")]: -6,
      [HV(2, "on")]: 1,
      [HV(2, "interval")]: 12,
      [HV(2, "level")]: 45,
      [HV(2, "pan")]: 0,
      [HV(2, "detune")]: 4,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 12, // → Harmony Mix
      [R.amount(0)]: 55,
      [R.smooth(0)]: 140,
    },
  ),
  preset(
    "morph-exp-dark-body-stack",
    "Dark Body Stack",
    "bass",
    "Bloom",
    "strong",
    "BODY Harmonizer: −12/−5/−3 under the sustained body — a dark stack that thickens held notes and 808 tails while the attack keeps its definition.",
    {
      "harm.enabled": 1,
      "harm.bodyAmount": 80,
      "harm.mix": 50,
      [HV(0, "on")]: 1,
      [HV(0, "interval")]: -12,
      [HV(0, "level")]: 65,
      [HV(0, "pan")]: -25,
      [HV(1, "on")]: 1,
      [HV(1, "interval")]: -5,
      [HV(1, "level")]: 55,
      [HV(1, "pan")]: 30,
      [HV(2, "on")]: 1,
      [HV(2, "interval")]: -3,
      [HV(2, "level")]: 45,
      [HV(2, "pan")]: -60,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 12, // → Harmony Mix
      [R.amount(0)]: 50,
      [R.smooth(0)]: 110,
    },
  ),

  // ── EXPERIMENT #3: SPATIAL BLOOM (Phase III dev/reference states) ──
  // The three-arm comparison of the experiment doc §18: "Subtle Vocal
  // Bloom" (arm A/B — harmony, reactive mix) vs "Spatial Bloom" below
  // (arm C — same harmony WITH the reactive spatial field). Source 7 is
  // the Bloom control (curved, enveloped BODY energy); the layered
  // smoothMs values implement §9 (spread fast → space slow).
  preset(
    "morph-exp-spatial-bloom",
    "Spatial Bloom",
    "vocal",
    "Bloom",
    "strong",
    "Full Harmonic Bloom: harmony rises out of sustained vocal tone AND the harmonic cloud opens with it — voices spread, diffusion softens the stack, a short space blooms on loud phrases and contracts when the phrase ends.",
    {
      "harm.enabled": 1,
      "harm.bodyAmount": 80,
      "harm.mix": 30,
      "harm.bloom": 75,
      "harm.spread": 100,
      "harm.width": 130,
      "harm.diffusion": 35,
      "harm.space": 25,
      [HV(0, "on")]: 1,
      [HV(0, "interval")]: 7,
      [HV(0, "level")]: 60,
      [HV(0, "pan")]: -35,
      [HV(0, "detune")]: -4,
      [HV(1, "on")]: 1,
      [HV(1, "interval")]: 12,
      [HV(1, "level")]: 45,
      [HV(1, "pan")]: 35,
      [HV(1, "detune")]: 3,
      [HV(2, "on")]: 1,
      [HV(2, "interval")]: 3,
      [HV(2, "level")]: 40,
      [HV(2, "pan")]: -70,
      [HV(3, "on")]: 1,
      [HV(3, "interval")]: -5,
      [HV(3, "level")]: 40,
      [HV(3, "pan")]: 70,
      [R.enabled(0)]: 1,
      [R.source(0)]: 3, // Body
      [R.dest(0)]: 12, // → Harmony Mix
      [R.amount(0)]: 60,
      [R.smooth(0)]: 120,
      [R.enabled(1)]: 1,
      [R.source(1)]: 7, // Bloom
      [R.dest(1)]: 13, // → Voice Spread
      [R.amount(1)]: 55,
      [R.smooth(1)]: 60,
      [R.enabled(2)]: 1,
      [R.source(2)]: 7, // Bloom
      [R.dest(2)]: 15, // → Harmony Diffusion
      [R.amount(2)]: 65,
      [R.smooth(2)]: 160,
      [R.enabled(3)]: 1,
      [R.source(3)]: 7, // Bloom
      [R.dest(3)]: 16, // → Harmony Space
      [R.amount(3)]: 60,
      [R.smooth(3)]: 220,
    },
  ),
  preset(
    "morph-exp-harmonic-cloud",
    "Harmonic Cloud",
    "synth",
    "Bloom",
    "extreme",
    "Harmonic Bloom for pads and leads: a ±7/+12/+19 stack whose spread, width and diffusion breathe with the performance — wide and diffused on energetic sustains, pulled back toward a centered intimate core when the part rests.",
    {
      "harm.enabled": 1,
      "harm.bodyAmount": 70,
      "harm.mix": 45,
      "harm.bloom": 90,
      "harm.spread": 110,
      "harm.width": 145,
      "harm.diffusion": 55,
      "harm.space": 30,
      [HV(0, "on")]: 1,
      [HV(0, "interval")]: 7,
      [HV(0, "level")]: 55,
      [HV(0, "pan")]: -60,
      [HV(1, "on")]: 1,
      [HV(1, "interval")]: -7,
      [HV(1, "level")]: 55,
      [HV(1, "pan")]: 60,
      [HV(2, "on")]: 1,
      [HV(2, "interval")]: 12,
      [HV(2, "level")]: 50,
      [HV(2, "pan")]: -25,
      [HV(2, "detune")]: 7,
      [HV(3, "on")]: 1,
      [HV(3, "interval")]: 19,
      [HV(3, "level")]: 35,
      [HV(3, "pan")]: 25,
      [HV(3, "detune")]: -7,
      [R.enabled(0)]: 1,
      [R.source(0)]: 7, // Bloom
      [R.dest(0)]: 13, // → Voice Spread
      [R.amount(0)]: 65,
      [R.smooth(0)]: 70,
      [R.enabled(1)]: 1,
      [R.source(1)]: 7, // Bloom
      [R.dest(1)]: 14, // → Harmony Width
      [R.amount(1)]: 45,
      [R.smooth(1)]: 90,
      [R.enabled(2)]: 1,
      [R.source(2)]: 7, // Bloom
      [R.dest(2)]: 15, // → Harmony Diffusion
      [R.amount(2)]: 70,
      [R.smooth(2)]: 170,
      [R.enabled(3)]: 1,
      [R.source(3)]: 3, // Body
      [R.dest(3)]: 12, // → Harmony Mix
      [R.amount(3)]: 45,
      [R.smooth(3)]: 130,
    },
  ),
];

/**
 * Merge a preset onto the full defaults and clamp every value through the
 * schema — presets are data: unknown ids and out-of-range values from
 * older schemas are dropped/clamped, never forwarded verbatim.
 */
export function applyMorphPreset(presetParams: Record<string, number>): Record<string, number> {
  const merged = buildDefaultParams();
  for (const [id, value] of Object.entries(presetParams)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (!PARAM_BY_ID.has(id)) continue;
    merged[id] = value;
  }
  // One canonical clamp pass (schema ranges; route enum bounds included).
  for (const [id, value] of Object.entries(merged)) {
    merged[id] = clampParam(id, value);
  }
  return merged;
}
