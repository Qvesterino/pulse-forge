import type { EffectType } from "../project-model/types";

export interface BeatmakingEffectChainItem {
  type: EffectType;
  presetId: string;
}

export interface BeatmakingEffectChain {
  id: string;
  name: string;
  description: string;
  effects: BeatmakingEffectChainItem[];
}

/** Short, gain-matched starting chains for the most common beatmaking jobs. */
export const BEATMAKING_EFFECT_CHAINS: BeatmakingEffectChain[] = [
  {
    id: "808-harmonics",
    name: "808 HARMONICS",
    description: "Add readable upper harmonics while keeping the sub centered and controlled.",
    effects: [
      { type: "tapeSat", presetId: "tape-808-harmonics" },
      { type: "eq", presetId: "eq-air" },
    ],
  },
  {
    id: "bass-phone-ready",
    name: "BASS PHONE READY",
    description: "Missing-fundamental harmonics plus an air lift so the bass reads on phone speakers.",
    effects: [
      { type: "bassHarmonic", presetId: "bassharmonic-808-phone" },
      { type: "eq", presetId: "eq-air" },
    ],
  },
  {
    id: "phase-throw",
    name: "PHASE THROW",
    description: "Disperse the attack around the body band, then lift the air so the click leads.",
    effects: [
      { type: "skrutka", presetId: "skrutka-808-throw" },
      { type: "eq", presetId: "eq-air" },
    ],
  },
  {
    id: "phase-spectral-throw",
    name: "PHASE-SPECTRAL THROW",
    description: "Fan the sides with phase dispersion, then drift a short spectral tail behind the hits.",
    effects: [
      { type: "skrutka", presetId: "skrutka-field-wide" },
      { type: "portal", presetId: "portal-air-drift" },
    ],
  },
  {
    id: "808-space-ladder",
    name: "808 SPACE LADDER",
    description: "Phone-ready harmonics, kick-cleared phase, and a sliding spectral echo under the glide.",
    effects: [
      { type: "bassHarmonic", presetId: "bassharmonic-808-phone" },
      { type: "skrutka", presetId: "skrutka-kick-duck-phase" },
      { type: "portal", presetId: "portal-echo-dive" },
    ],
  },
  {
    id: "ghost-pad",
    name: "GHOST PAD",
    description: "Sides-only shimmer feeding a frozen spectral pad — the mono centre stays solid.",
    effects: [
      { type: "skrutka", presetId: "skrutka-side-shimmer" },
      { type: "portal", presetId: "portal-time-cap" },
    ],
  },
  {
    id: "hyper-glitch",
    name: "HYPER GLITCH",
    description: "Pitch the source, chirp the phase, then gate it through a spectral stutter.",
    effects: [
      { type: "pitchShift", presetId: "pitchshift-down" },
      { type: "skrutka", presetId: "skrutka-chirp-rise" },
      { type: "portal", presetId: "portal-sync-stutter" },
    ],
  },
  {
    id: "kick-punch",
    name: "KICK PUNCH",
    description: "Bring the transient forward, then catch peaks with a soft ceiling.",
    effects: [
      { type: "transient", presetId: "transient-punch" },
      { type: "clipper", presetId: "clipper-kick" },
    ],
  },
  {
    id: "snare-snap",
    name: "SNARE SNAP",
    description: "Transient snap with a bright, restrained tape crack.",
    effects: [
      { type: "transient", presetId: "transient-punch" },
      { type: "tapeSat", presetId: "tape-hot" },
    ],
  },
  {
    id: "drum-glue",
    name: "DRUM GLUE",
    description: "A light Drum Buss texture followed by low-ratio bus compression.",
    effects: [
      { type: "drumBuss", presetId: "drum-glue" },
      { type: "compressor", presetId: "comp-glue" },
    ],
  },
  {
    id: "vocal-chop",
    name: "VOCAL CHOP",
    description: "Pitch the source, then probability-gate short tempo-synced repeats.",
    effects: [
      { type: "pitchShift", presetId: "pitchshift-down" },
      { type: "beatMangler", presetId: "beatmangler-skip" },
    ],
  },
  {
    id: "hat-space",
    name: "HAT SPACE",
    description: "Stagger light stereo hat taps into a short, filtered RIFT tail.",
    effects: [
      { type: "multiTapDelay", presetId: "multitap-pingpong-hats" },
      { type: "kaskada", presetId: "kaskada-hat-sync" },
    ],
  },
  {
    id: "dusty-loop",
    name: "DUSTY LOOP",
    description: "Add restrained vinyl wear and warm tape tone to a loop.",
    effects: [
      { type: "vinyl", presetId: "vinyl-dusty-lofi" },
      { type: "tapeSat", presetId: "tape-warm" },
    ],
  },
];
