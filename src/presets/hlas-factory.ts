/**
 * HĽAS factory presets (ADR 0059) — four lead voices across the vowel and
 * breath space. Fully synthesized (no samples). The MPE timbre → vowel
 * morph and pressure → breath are the expressive layer on top of every
 * preset.
 */

import type { InstrumentPreset, PresetGenre, PresetMood } from "./types";

interface HlasPresetSpec {
  key: string;
  name: string;
  genre: PresetGenre;
  mood: PresetMood[];
  tags: string[];
  params: Record<string, number>;
}

const SPECS: HlasPresetSpec[] = [
  {
    key: "ah-lead",
    name: "Ah Lead",
    genre: "score",
    mood: ["warm", "clean"],
    tags: ["vocal", "lead", "ah", "expression"],
    params: {
      vowelA: 0, // A
      vowelB: 0,
      morph: 0,
      formantScale: 1,
      breath: 0.25,
      pulse: 0.35,
      vibratoRate: 5.5,
      vibratoDepth: 16,
      glide: 0.07,
      attack: 0.03,
      release: 0.3,
      level: 0.8,
    },
  },
  {
    key: "oo-pad-lead",
    name: "Oo Pad Lead",
    genre: "ambient",
    mood: ["dark", "atmosphere"],
    tags: ["vocal", "oo", "hollow", "pad-lead"],
    params: {
      vowelA: 4, // U
      vowelB: 3, // O
      morph: 0.4,
      formantScale: 0.85,
      breath: 0.35,
      pulse: 0.15,
      vibratoRate: 4.5,
      vibratoDepth: 10,
      glide: 0.12,
      attack: 0.35,
      release: 1.4,
      level: 0.75,
    },
  },
  {
    key: "sax-breath",
    name: "Sax Breath",
    genre: "drill",
    mood: ["dark", "aggressive"],
    tags: ["breathy", "sax", "reedy", "expression"],
    params: {
      vowelA: 3, // O
      vowelB: 1, // E
      morph: 0.35,
      formantScale: 1.15,
      breath: 0.55,
      pulse: 0.6,
      vibratoRate: 6,
      vibratoDepth: 8,
      glide: 0.04,
      attack: 0.015,
      release: 0.18,
      level: 0.7,
    },
  },
  {
    key: "ee-wa-sweep",
    name: "Ee→Wa Sweep",
    genre: "house",
    mood: ["bright", "clean"],
    tags: ["vowel-sweep", "ee", "morph", "mpe"],
    params: {
      vowelA: 2, // I
      vowelB: 0, // A — the MPE wheel sweeps I→A (the "wa" shape)
      morph: 0,
      formantScale: 1.05,
      breath: 0.12,
      pulse: 0.5,
      vibratoRate: 5,
      vibratoDepth: 6,
      glide: 0.05,
      attack: 0.006,
      release: 0.22,
      level: 0.75,
    },
  },
];

/** All HĽAS factory presets (deterministic order). */
export const HLAS_FACTORY_PRESETS: InstrumentPreset[] = SPECS.map((spec) => ({
  id: `factory.hlas.${spec.key}`,
  name: spec.name,
  instrument: "hlas",
  genre: spec.genre,
  mood: spec.mood,
  tags: spec.tags,
  params: { ...spec.params },
}));
