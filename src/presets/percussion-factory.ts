/**
 * ŠTRK & CINK factory presets (ADR 0060) — four snare designs and four hat
 * designs across the acoustic/electronic space. Fully synthesized.
 */

import type { InstrumentPreset, PresetGenre, PresetMood } from "./types";

interface PercPresetSpec {
  key: string;
  name: string;
  genre: PresetGenre;
  mood: PresetMood[];
  tags: string[];
  params: Record<string, number>;
}

const STRK_SPECS: PercPresetSpec[] = [
  {
    key: "acoustic-crack",
    name: "Acoustic Crack",
    genre: "house",
    mood: ["bright", "aggressive"],
    tags: ["snare", "acoustic", "crack", "backbeat"],
    params: {
      tune: 0,
      snapLevel: 0.55,
      snapDecay: 0.005,
      bodyLevel: 0.45,
      bodyDecay: 0.11,
      bodyTone: 0.3,
      wireLevel: 0.65,
      wireTone: 3800,
      wireDecay: 0.17,
      snappy: 0.7,
      drive: 0.25,
      level: 0.8,
    },
  },
  {
    key: "808-long-body",
    name: "808 Long Body",
    genre: "trap",
    mood: ["deep", "dark"],
    tags: ["snare", "808", "long", "body"],
    params: {
      tune: -5,
      snapLevel: 0.3,
      snapDecay: 0.004,
      bodyLevel: 0.7,
      bodyDecay: 0.35,
      bodyTone: 0.1,
      wireLevel: 0.4,
      wireTone: 2400,
      wireDecay: 0.4,
      snappy: 0.35,
      drive: 0.15,
      level: 0.8,
    },
  },
  {
    key: "drill-snap",
    name: "Drill Snap",
    genre: "drill",
    mood: ["aggressive", "clean"],
    tags: ["snare", "snap", "short", "drill"],
    params: {
      tune: 3,
      snapLevel: 0.7,
      snapDecay: 0.002,
      bodyLevel: 0.3,
      bodyDecay: 0.06,
      bodyTone: 0.5,
      wireLevel: 0.45,
      wireTone: 5200,
      wireDecay: 0.08,
      snappy: 0.8,
      drive: 0.4,
      level: 0.8,
    },
  },
  {
    key: "lofi-soft",
    name: "Lofi Soft",
    genre: "phonk",
    mood: ["warm", "dark"],
    tags: ["snare", "lofi", "soft", "dusty"],
    params: {
      tune: -3,
      snapLevel: 0.3,
      snapDecay: 0.008,
      bodyLevel: 0.5,
      bodyDecay: 0.16,
      bodyTone: 0.15,
      wireLevel: 0.4,
      wireTone: 2200,
      wireDecay: 0.22,
      snappy: 0.45,
      drive: 0.1,
      level: 0.8,
    },
  },
];

const CINK_SPECS: PercPresetSpec[] = [
  {
    key: "closed-tight",
    name: "Closed Tight",
    genre: "house",
    mood: ["clean", "aggressive"],
    tags: ["hat", "closed", "tight", "backbeat"],
    params: {
      tune: 0,
      decay: 0.06,
      chirp: 0.35,
      chirpTime: 0.012,
      hpTone: 8000,
      metalSpread: 0.12,
      pulseMix: 0.6,
      drive: 0.3,
      level: 0.8,
    },
  },
  {
    key: "open-wide",
    name: "Open Wide",
    genre: "techno",
    mood: ["bright", "atmosphere"],
    tags: ["hat", "open", "wide", "wash"],
    params: {
      tune: 0,
      decay: 0.9,
      chirp: 0.2,
      chirpTime: 0.04,
      hpTone: 6500,
      metalSpread: 0.2,
      pulseMix: 0.45,
      drive: 0.2,
      level: 0.75,
    },
  },
  {
    key: "sizzle",
    name: "Sizzle",
    genre: "dnb",
    mood: ["bright", "aggressive"],
    tags: ["hat", "sizzle", "bright", "dnb"],
    params: {
      tune: 3,
      decay: 0.3,
      chirp: 0.5,
      chirpTime: 0.02,
      hpTone: 9500,
      metalSpread: 0.28,
      pulseMix: 0.75,
      drive: 0.45,
      level: 0.8,
    },
  },
  {
    key: "dark-cymbal",
    name: "Dark Cymbal",
    genre: "phonk",
    mood: ["dark", "deep"],
    tags: ["hat", "dark", "cymbal", "low"],
    params: {
      tune: -5,
      decay: 0.7,
      chirp: 0.15,
      chirpTime: 0.06,
      hpTone: 4500,
      metalSpread: 0.1,
      pulseMix: 0.3,
      drive: 0.15,
      level: 0.8,
    },
  },
];

/** All ŠTRK factory presets (deterministic order). */
export const STRK_FACTORY_PRESETS: InstrumentPreset[] = STRK_SPECS.map((spec) => ({
  id: `factory.strk.${spec.key}`,
  name: spec.name,
  instrument: "strk",
  genre: spec.genre,
  mood: spec.mood,
  tags: spec.tags,
  params: { ...spec.params },
}));

/** All CINK factory presets (deterministic order). */
export const CINK_FACTORY_PRESETS: InstrumentPreset[] = CINK_SPECS.map((spec) => ({
  id: `factory.cink.${spec.key}`,
  name: spec.name,
  instrument: "cink",
  genre: spec.genre,
  mood: spec.mood,
  tags: spec.tags,
  params: { ...spec.params },
}));
