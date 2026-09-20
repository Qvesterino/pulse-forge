/** Velocity quantization levels for Markov state */
export type VelocityLevel = 0 | 1 | 2 | 3;

/** Encoded state index = level * stepsPerBar + position */
export type StateIndex = number;

/** Markov chain model for one drum pad */
export interface PadMarkovModel {
  padIndex: number;
  states: number;
  /** Flat row-major matrix: transitions[from * states + to] = count */
  transitions: Uint32Array;
  /** Initial state distribution (counts) */
  initial: Uint32Array;
}

/** Groove data — one style variation within a genre */
/** All available genres (song forms, grooves and intent parsing key off this). */
export type Genre = "house" | "techno" | "trap" | "ambient" | "drill" | "phonk";

export interface GrooveData {
  id: string;
  genre: Genre;
  name: string;
  bpm: [number, number];
  swing: number;
  /**
   * Per-pad velocity arrays. Keys are pad indices (0-15).
   * Each value is an array of velocity values (0 = off, 0.1-1 = hit).
   * All patterns within a groove must have the same length (16 steps).
   */
  patterns: { [padIndex: number]: number[] }[];
  /** Which pad indices are active in this groove */
  activePads: number[];
}

/** User-facing generation options */
export type GenerationRole = "drums" | "bass" | "chords" | "lead";

export interface GenerationConstraints {
  preserveAnchors: boolean;
  allowGhosts: boolean;
  allowSwing: boolean;
}

export interface GenerateOptions {
  genre: Genre;
  style?: string;
  seed: string;
  stepCount: number;
  /** Explicit key binding. Null means use the project's key, if any. */
  key?: import("../project-model/types").MusicalKey | null;
  /** Requested BPM range. Null/undefined leaves the project BPM unchanged. */
  bpmRange?: [number, number] | null;
  /** Enabled semantic output roles. Omitted means all roles for backwards compatibility. */
  roles?: readonly GenerationRole[];
  /** Hard generation constraints. Omitted means the legacy permissive defaults. */
  constraints?: GenerationConstraints;
  /** Number of deterministic local candidates to rank. Defaults to one. */
  candidateCount?: number;
  ghostWeight: number;
  microWeight: number;
  velocityVariation: number;
  temperature: number;
  replaceMode: "new" | "replace";
  drumTrackId?: string;
  instrumentTrackIds?: string[];
  /** If set, hash this pattern's rows to derive the seed for variation */
  sourcePatternId?: string;
  /** If true, set project groove (swing/humanize) from the resolved groove */
  applyGrooveSettings?: boolean;
  /** Dice intent hints (optional, not persisted) — density/complexity/energy shape drums */
  _diceDensity?: number;
  _diceComplexity?: number;
  _diceEnergy?: number;
  /** Dice swing jitter — absolute swing 0..1 to use instead of groove.swing */
  _diceSwing?: number;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  genre: "house",
  seed: "",
  stepCount: 16,
  ghostWeight: 0.3,
  microWeight: 0.2,
  velocityVariation: 0.3,
  temperature: 1.0,
  replaceMode: "new",
};

/** All available genres */
export const GENRES = ["house", "techno", "trap", "ambient", "drill", "phonk"] as const;

/** Pad index → name mapping (matches makeKit in schema.ts) */
export const PAD_NAMES: readonly string[] = [
  "Kick Deep",
  "Kick Punch",
  "Kick Techno",
  "Rim",
  "Snare",
  "Snare Tight",
  "Clap",
  "Shaker",
  "Hat Closed",
  "Hat Soft",
  "Hat Open",
  "Ride",
  "Tom Low",
  "Tom High",
  "Tick",
  "Blip",
];

// ── Melodic types ────────────────────────────────────────

/** A single note in a melodic reference pattern */
export interface MelodicNote {
  /** Scale degree (0 = root, 1 = second, etc.). -1 = rest. */
  degree: number;
  /** Duration in steps (1=16th, 2=8th, 4=quarter, 8=half) */
  duration: number;
  /** Velocity 0-1 */
  velocity: number;
}

/** A melodic reference pattern for one instrument part */
export interface MelodicPatternData {
  /** Instrument role */
  role: "bass" | "chord" | "lead";
  /** Octave offset from middle (0=C3 range, +1 = one octave up) */
  octaveOffset: number;
  /** Reference note sequences (multiple variations) */
  sequences: MelodicNote[][];
}

/** Extended groove data with melodic content */
export interface GrooveWithMelodic extends GrooveData {
  melodic?: MelodicPatternData[];
}
