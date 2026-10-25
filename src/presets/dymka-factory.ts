/**
 * DYMKA factory presets (ADR 0062) — four wind voices across the
 * wave/formant/breath space. Fully synthesized (no samples). Every preset
 * is an MPE playground: pressure swells and brightens, the jaw adds
 * vibrato.
 */

import type { InstrumentPreset, PresetGenre, PresetMood } from "./types";

interface DymkaPresetSpec {
  key: string;
  name: string;
  genre: PresetGenre;
  mood: PresetMood[];
  tags: string[];
  params: Record<string, number>;
}

const SPECS: DymkaPresetSpec[] = [
  {
    key: "sax-lead",
    name: "Sax Lead",
    genre: "drill",
    mood: ["dark", "aggressive"],
    tags: ["wind", "sax", "lead", "mpe"],
    params: {
      wave: 0,
      breath: 0.75,
      brightBase: 0.5,
      reedLevel: 0.45,
      reedTone: 2600,
      pitchLift: 15,
      formant1: 620,
      formant2: 1600,
      bodyTone: 1,
      vibRate: 5.2,
      vibDepth: 14,
      attack: 0.03,
      release: 0.18,
      legato: 1,
      level: 0.8,
    },
  },
  {
    key: "clarinet",
    name: "Clarinet",
    genre: "score",
    mood: ["clean", "warm"],
    tags: ["wind", "clarinet", "square", "hollow"],
    params: {
      wave: 1,
      breath: 0.65,
      brightBase: 0.35,
      reedLevel: 0.25,
      reedTone: 3200,
      pitchLift: 6,
      formant1: 900,
      formant2: 2200,
      bodyTone: 0.95,
      vibRate: 4.5,
      vibDepth: 8,
      attack: 0.05,
      release: 0.25,
      legato: 1,
      level: 0.75,
    },
  },
  {
    key: "trumpet-stack",
    name: "Trumpet Stack",
    genre: "house",
    mood: ["bright", "aggressive"],
    tags: ["wind", "trumpet", "brass", "stack"],
    params: {
      wave: 0,
      breath: 0.85,
      brightBase: 0.7,
      reedLevel: 0.3,
      reedTone: 3600,
      pitchLift: 22,
      formant1: 750,
      formant2: 1900,
      bodyTone: 1.15,
      vibRate: 5.8,
      vibDepth: 18,
      attack: 0.02,
      release: 0.15,
      legato: 0,
      level: 0.8,
    },
  },
  {
    key: "breath-pad",
    name: "Breath Pad",
    genre: "ambient",
    mood: ["atmosphere", "warm"],
    tags: ["wind", "breath", "pad", "soft"],
    params: {
      wave: 0,
      breath: 0.5,
      brightBase: 0.25,
      reedLevel: 0.6,
      reedTone: 2000,
      pitchLift: 4,
      formant1: 520,
      formant2: 1400,
      bodyTone: 0.85,
      vibRate: 3.8,
      vibDepth: 6,
      attack: 0.4,
      release: 1.2,
      legato: 0,
      level: 0.7,
    },
  },
];

/** All DYMKA factory presets (deterministic order). */
export const DYMKA_FACTORY_PRESETS: InstrumentPreset[] = SPECS.map((spec) => ({
  id: `factory.dymka.${spec.key}`,
  name: spec.name,
  instrument: "dymka",
  genre: spec.genre,
  mood: spec.mood,
  tags: spec.tags,
  params: { ...spec.params },
}));
