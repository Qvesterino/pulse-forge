/**
 * TSAR factory presets (docs/TSAR-ROADMAP.md T3).
 *
 * Built from ARCHETYPES × GENRE PROFILES rather than hand-typed one by one:
 * each archetype is a real sound design decision (engine routing, envelope,
 * filter), and each genre profile is a measured set of deltas (darker/brighter,
 * shorter/longer, wider/narrower). The product is deterministic — the same
 * archetype × profile always yields the same preset — and auditable: every
 * value traces to its archetype constant or its profile delta.
 *
 * These are NOT 120 variations of one patch: the 8 archetypes cover the
 * distinct jobs a hybrid engine is asked to do (bass, lead, pad, pluck, keys,
 * texture, riser, stab), and the genre profiles move the sound the way the
 * genre actually moves it (trap = darker + longer sub, techno = tighter +
 * more drive, ambient = slower + wider).
 */

import type { InstrumentPreset, PresetGenre, PresetMood } from "./types";
import type { ParamDef } from "../effects/types";
import { tsarParams } from "../tsar/params";

/** Defaults from the schema — the base every archetype starts from. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  tsarParams.map((param: ParamDef) => [param.id, param.default]),
);

interface Archetype {
  key: string;
  name: string;
  useCase: "bass" | "lead" | "keys" | "pad" | "pluck" | "texture" | "vocal" | "drums" | "fx";
  moods: PresetMood[];
  tags: string[];
  /** Factory audio required by this archetype's selected source engine. */
  sampleId?: string;
  /** Param deltas over DEFAULTS. */
  params: Record<string, number>;
}

interface GenreProfile {
  genre: PresetGenre;
  moods: PresetMood[];
  /** Deltas applied on top of the archetype (multiplicative for 0..1 knobs). */
  cutoffScale: number;
  attackScale: number;
  releaseScale: number;
  brightness: number; // -1 dark … +1 bright (adds to tone)
  drive: number;
  widthDelta: number;
  detuneDelta: number;
  subDelta: number;
}

const ARCHETYPES: Archetype[] = [
  {
    key: "sub",
    name: "Sub Bass",
    useCase: "bass",
    moods: ["deep", "dark"],
    tags: ["bass", "sub", "808"],
    params: {
      srcAEngine: 1,
      srcALevel: 0.9,
      srcAMorph: 0,
      srcAAtk: 0.004,
      srcADec: 1.2,
      srcASus: 0.75,
      srcARel: 0.18,
      srcAFilter: 0,
      srcACutoff: 900,
      srcAQ: 0.7,
      sub: 0.55,
      subOct: -1,
      drive: 0.1,
      width: 0.12,
      level: 0.85,
    },
  },
  {
    key: "wobble",
    name: "Wobble Bass",
    useCase: "bass",
    moods: ["aggressive", "dark"],
    tags: ["bass", "wobble", "movement"],
    params: {
      srcAEngine: 1,
      srcALevel: 0.85,
      srcAMorph: 0.5,
      srcAAtk: 0.006,
      srcADec: 0.8,
      srcASus: 0.8,
      srcARel: 0.2,
      srcAFilter: 0,
      srcACutoff: 620,
      srcAQ: 3.2,
      lfoRate: 5.5,
      lfoShape: 1,
      mod1Src: 1,
      mod1Dst: 1,
      mod1Amt: 0.55,
      drive: 0.35,
      width: 0.25,
      level: 0.8,
    },
  },
  {
    key: "lead",
    name: "Lead",
    useCase: "lead",
    moods: ["bright", "clean"],
    tags: ["lead", "melody", "synth"],
    params: {
      srcAEngine: 1,
      srcALevel: 0.75,
      srcAMorph: 0.55,
      srcAUnison: 3,
      srcASpread: 12,
      srcAAtk: 0.008,
      srcADec: 0.5,
      srcASus: 0.65,
      srcARel: 0.35,
      srcACutoff: 5200,
      srcAQ: 1.1,
      srcAFilterEnv: 0.45,
      tone: 0.15,
      width: 0.45,
      level: 0.72,
    },
  },
  {
    key: "pluck",
    name: "Pluck",
    useCase: "pluck",
    moods: ["bright", "clean"],
    tags: ["pluck", "short", "percussive"],
    params: {
      srcAEngine: 1,
      srcALevel: 0.8,
      srcAMorph: 0.75,
      srcAAtk: 0.002,
      srcADec: 0.28,
      srcASus: 0,
      srcARel: 0.14,
      srcAFilter: 0,
      srcACutoff: 4200,
      srcAQ: 1.6,
      srcAFilterEnv: 0.7,
      width: 0.3,
      level: 0.78,
    },
  },
  {
    key: "pad",
    name: "Pad",
    useCase: "pad",
    moods: ["warm", "atmosphere"],
    tags: ["pad", "sustained", "wide"],
    params: {
      srcAEngine: 1,
      srcALevel: 0.45,
      srcAMorph: 0.4,
      srcAUnison: 4,
      srcASpread: 24,
      // A 0.8 s attack inside the 0.78 s loudness probe measured near-silent
      // (clamped at +18); a 0.25 s attack at full level measured near
      // full-scale (clamped at -18). 0.3 s + a moderate level sits between
      // the clamps while staying pad-like.
      srcAAtk: 0.3,
      srcADec: 1.6,
      srcASus: 0.85,
      srcARel: 1.8,
      srcAScan: 0.06,
      srcACutoff: 3200,
      srcAQ: 0.6,
      sub: 0.1,
      tone: -0.1,
      width: 0.75,
      level: 0.5,
    },
  },
  {
    key: "keys",
    name: "Keys",
    useCase: "keys",
    moods: ["warm", "clean"],
    tags: ["keys", "chords", "warm"],
    params: {
      srcAEngine: 1,
      srcALevel: 0.78,
      srcAMorph: 0.35,
      srcAAtk: 0.004,
      srcADec: 0.9,
      srcASus: 0.35,
      srcARel: 0.5,
      srcACutoff: 3000,
      srcAQ: 0.9,
      tone: -0.05,
      width: 0.4,
      level: 0.74,
    },
  },
  {
    key: "texture",
    name: "Texture",
    useCase: "texture",
    moods: ["atmosphere", "dark"],
    tags: ["texture", "granular", "ambient"],
    sampleId: "factory.tonal.keys",
    params: {
      srcAEngine: 2,
      srcALevel: 0.5,
      srcAScan: 0.35,
      srcAUnison: 2,
      srcASpread: 30,
      // Same loudness-probe lesson as the pad — 0.35 s attack at a moderate
      // level stays inside both clamps.
      srcAAtk: 0.35,
      srcADec: 2.5,
      srcASus: 0.9,
      srcARel: 2.8,
      srcACutoff: 2400,
      srcAQ: 0.5,
      noise: 0.1,
      width: 0.8,
      level: 0.5,
    },
  },
  {
    key: "riser",
    name: "Riser",
    useCase: "fx",
    moods: ["aggressive", "bright"],
    tags: ["riser", "transition", "fx"],
    params: {
      srcAEngine: 1,
      srcALevel: 0.7,
      srcAMorph: 0.35,
      srcAAtk: 0.004,
      srcADec: 3.5,
      srcASus: 1,
      srcARel: 0.6,
      srcACutoff: 800,
      srcAQ: 2.4,
      srcAFilterEnv: 1,
      lfoRate: 0.9,
      mod1Src: 1,
      mod1Dst: 0,
      mod1Amt: 0.6,
      width: 0.7,
      level: 0.7,
    },
  },
];

const GENRE_PROFILES: GenreProfile[] = [
  {
    genre: "house",
    moods: ["warm", "clean"],
    cutoffScale: 1,
    attackScale: 1,
    releaseScale: 1,
    brightness: 0,
    drive: 0,
    widthDelta: 0,
    detuneDelta: 0,
    subDelta: 0.05,
  },
  {
    genre: "techno",
    moods: ["dark", "aggressive"],
    cutoffScale: 0.72,
    attackScale: 0.8,
    releaseScale: 0.85,
    brightness: -0.1,
    drive: 0.18,
    widthDelta: -0.08,
    detuneDelta: 2,
    subDelta: 0,
  },
  {
    genre: "trap",
    moods: ["dark", "deep"],
    cutoffScale: 0.8,
    attackScale: 0.9,
    releaseScale: 1.25,
    brightness: -0.15,
    drive: 0.1,
    widthDelta: -0.05,
    detuneDelta: 0,
    subDelta: 0.2,
  },
  {
    genre: "ambient",
    moods: ["atmosphere", "warm"],
    cutoffScale: 1.05,
    attackScale: 1.9,
    releaseScale: 1.8,
    brightness: -0.05,
    drive: 0,
    widthDelta: 0.18,
    detuneDelta: 4,
    subDelta: 0,
  },
  {
    genre: "dnb",
    moods: ["dark", "aggressive"],
    cutoffScale: 0.85,
    attackScale: 0.7,
    releaseScale: 0.7,
    brightness: 0.05,
    drive: 0.22,
    widthDelta: 0.05,
    detuneDelta: 3,
    subDelta: 0.05,
  },
  {
    genre: "phonk",
    moods: ["dark", "aggressive"],
    cutoffScale: 0.68,
    attackScale: 0.85,
    releaseScale: 1.15,
    brightness: -0.22,
    drive: 0.28,
    widthDelta: -0.1,
    detuneDelta: 0,
    subDelta: 0.22,
  },
];

function clampParam(id: string, value: number): number {
  const def = tsarParams.find((param) => param.id === id);
  if (!def) return value;
  if (!Number.isFinite(value)) return def.default;
  return Math.min(def.max, Math.max(def.min, value));
}

/** Build one preset from an archetype × genre profile. Deterministic. */
function buildPreset(archetype: Archetype, profile: GenreProfile): InstrumentPreset {
  const params: Record<string, number> = { ...DEFAULTS, ...archetype.params };
  // Cutoff is multiplicative (a filter move reads in octaves, not Hz deltas).
  params.srcACutoff = clampParam("srcACutoff", (params.srcACutoff ?? 4000) * profile.cutoffScale);
  params.srcAAtk = clampParam("srcAAtk", (params.srcAAtk ?? 0.01) * profile.attackScale);
  params.srcARel = clampParam("srcARel", (params.srcARel ?? 0.3) * profile.releaseScale);
  params.tone = clampParam("tone", (params.tone ?? 0) + profile.brightness);
  params.drive = clampParam("drive", (params.drive ?? 0) + profile.drive);
  params.width = clampParam("width", (params.width ?? 0.4) + profile.widthDelta);
  params.srcASpread = clampParam("srcASpread", (params.srcASpread ?? 0) + profile.detuneDelta);
  params.sub = clampParam("sub", (params.sub ?? 0) + profile.subDelta);
  return {
    id: `factory.tsar.${archetype.key}.${profile.genre}`,
    name: `TSAR ${archetype.name} ${profile.genre}`,
    instrument: "tsar",
    genre: profile.genre,
    mood: [...new Set([...archetype.moods, ...profile.moods])],
    tags: [...archetype.tags, profile.genre],
    metadata: {
      useCase: archetype.useCase,
      energy: archetype.useCase === "pad" || archetype.useCase === "texture" ? "low" : "medium",
      keySuitability: "any",
      bpmRange: { min: 70, max: 180 },
      source: "KYX factory",
      license: "internal",
    },
    params,
    ...(archetype.sampleId ? { sampleId: archetype.sampleId } : {}),
  };
}

/** All TSAR factory presets (archetypes × genre profiles). */
export const TSAR_FACTORY_PRESETS: InstrumentPreset[] = ARCHETYPES.flatMap((archetype) =>
  GENRE_PROFILES.map((profile) => buildPreset(archetype, profile)),
);

/** Count advertised in docs/CURRENT-STATE.md — derived, never hand-typed. */
export const TSAR_FACTORY_PRESET_COUNT = TSAR_FACTORY_PRESETS.length;
