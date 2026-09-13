import type { InstrumentKind } from "../project-model/types";

export type PresetGenre = "house" | "techno" | "trap" | "ambient" | "score";

export type PresetMood = "dark" | "bright" | "warm" | "aggressive" | "clean" | "deep" | "atmosphere";

export const PRESET_GENRES: PresetGenre[] = ["house", "techno", "trap", "ambient", "score"];

export const PRESET_MOODS: PresetMood[] = ["dark", "bright", "warm", "aggressive", "clean", "deep", "atmosphere"];

/** Musical job a sound is most useful for in the browser discovery flow. */
export type PresetUseCase = "bass" | "lead" | "keys" | "pad" | "pluck" | "texture" | "vocal" | "drums" | "fx";

export type PresetEnergy = "low" | "medium" | "high";

export interface PresetBpmRange {
  min: number;
  max: number;
}

/** Curated discovery/provenance metadata; this is not audio-engine state. */
export interface PresetMetadata {
  useCase: PresetUseCase;
  energy: PresetEnergy;
  keySuitability: "any";
  bpmRange: PresetBpmRange;
  source: "KYX factory" | "user library";
  license: "internal" | "user-owned" | "unknown";
}

/**
 * A preset is pure data (ARCHITECTURE.md §65): instrument + parameter values
 * (+ optional sampler sample). Applying it never touches the audio engine
 * directly — it flows through a command into the project model.
 */
export interface InstrumentPreset {
  id: string;
  name: string;
  instrument: InstrumentKind;
  genre: PresetGenre | null;
  mood: PresetMood[];
  tags: string[];
  /** Optional for backwards-compatible user presets; factory metadata is derived deterministically. */
  metadata?: PresetMetadata;
  params: Record<string, number>;
  sampleId?: string | null;
  user?: boolean;
}

export interface DrumSynthPreset {
  id: string;
  name: string;
  type: import("../project-model/types").DrumSynthType;
  genre: PresetGenre | null;
  mood: PresetMood[];
  tags: string[];
  synth: import("../project-model/types").DrumSynthConfig;
}
