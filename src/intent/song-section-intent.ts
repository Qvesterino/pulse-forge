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
    length: Math.min(256, section.bars * 16),
    energy: section.energy,
    density: section.density,
    complexity: section.complexity,
    candidateCount: section.candidateCount,
    roles: section.roles,
  });
}
