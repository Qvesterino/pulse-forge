/**
 * STRUNA factory presets (ADR 0061) — four plucked-string voices across
 * the pick/damping space. Fully synthesized (no samples).
 */

import type { InstrumentPreset, PresetGenre, PresetMood } from "./types";

interface StrunaPresetSpec {
  key: string;
  name: string;
  genre: PresetGenre;
  mood: PresetMood[];
  tags: string[];
  params: Record<string, number>;
}

const SPECS: StrunaPresetSpec[] = [
  {
    key: "nylon-pluck",
    name: "Nylon Pluck",
    genre: "score",
    mood: ["warm", "clean"],
    tags: ["string", "nylon", "pluck", "warm"],
    params: {
      pickPos: 0.25,
      pickSharp: 0.3,
      decay: 2.2,
      damp: 0.55,
      mute: 0.3,
      bodyLevel: 0.35,
      bodyTone: 0.9,
      drive: 0.05,
      level: 0.85,
    },
  },
  {
    key: "steel-bright",
    name: "Steel Bright",
    genre: "house",
    mood: ["bright", "clean"],
    tags: ["string", "steel", "bright", "pluck"],
    params: {
      pickPos: 0.18,
      pickSharp: 0.65,
      decay: 3.2,
      damp: 0.2,
      mute: 0.5,
      bodyLevel: 0.25,
      bodyTone: 1.15,
      drive: 0.12,
      level: 0.8,
    },
  },
  {
    key: "koto",
    name: "Koto",
    genre: "score",
    mood: ["clean", "aggressive"],
    tags: ["string", "koto", "sharp", "short"],
    params: {
      pickPos: 0.08,
      pickSharp: 0.85,
      decay: 1.4,
      damp: 0.3,
      mute: 0.6,
      bodyLevel: 0.2,
      bodyTone: 1.4,
      drive: 0.2,
      level: 0.8,
    },
  },
  {
    key: "low-drone",
    name: "Low Drone",
    genre: "ambient",
    mood: ["deep", "dark"],
    tags: ["string", "drone", "long", "dark"],
    params: {
      pickPos: 0.42,
      pickSharp: 0.2,
      decay: 6,
      damp: 0.7,
      mute: 1,
      bodyLevel: 0.4,
      bodyTone: 0.75,
      drive: 0.08,
      level: 0.85,
    },
  },
];

/** All STRUNA factory presets (deterministic order). */
export const STRUNA_FACTORY_PRESETS: InstrumentPreset[] = SPECS.map((spec) => ({
  id: `factory.struna.${spec.key}`,
  name: spec.name,
  instrument: "struna",
  genre: spec.genre,
  mood: spec.mood,
  tags: spec.tags,
  params: { ...spec.params },
}));
