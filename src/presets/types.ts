import type { InstrumentKind } from "../project-model/types";

export type PresetGenre = "house" | "techno" | "trap" | "ambient" | "score";

export const PRESET_GENRES: PresetGenre[] = ["house", "techno", "trap", "ambient", "score"];

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
  tags: string[];
  params: Record<string, number>;
  sampleId?: string | null;
  user?: boolean;
}
