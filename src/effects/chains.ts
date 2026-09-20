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
    id: "kick-punch",
    name: "KICK PUNCH",
    description: "Bring the transient forward, then catch peaks with a soft ceiling.",
    effects: [
      { type: "transient", presetId: "transient-punch" },
      { type: "clipper", presetId: "clipper-kick" },
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
    description: "Stagger light stereo hat taps into a short, filtered RYFT tail.",
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
