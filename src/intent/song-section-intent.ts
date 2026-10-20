import { normalizeIntent } from "./normalize";
import type { IntentRole, IntentSpec } from "./types";

export interface SongSectionIntentOverrides {
  index: number;
  role: string;
  bars: number;
  energy: number;
  density: number;
  complexity: number;
  candidateCount: number;
  roles: readonly IntentRole[];
  /** Song-level harmony plan (see IntentSpec.progression) — omitted on legacy paths. */
  progression?: string;
}

/**
 * Derive a section's generation intent without dropping the user's brief.
 * The section owns only its seed, length, intensity and role scope; artist,
 * mood, flow, text, profile, protected roles and provider conditioning remain
 * inherited from the full-song intent.
 */
export function createSongSectionIntent(baseIntent: IntentSpec, section: SongSectionIntentOverrides): IntentSpec {
  return normalizeIntent({
    ...baseIntent,
    seed: `${baseIntent.seed}|song:${section.index}:${section.role}`,
    // The section's length is asked in BARS; the document's meter turns it
    // into steps (a 4-bar section is 16 steps in 4/4 and 12 in 3/4).
    bars: section.bars,
    energy: section.energy,
    density: section.density,
    complexity: section.complexity,
    candidateCount: section.candidateCount,
    roles: section.roles,
    ...(section.progression ? { progression: section.progression } : {}),
  });
}
