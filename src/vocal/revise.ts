import { replacePatternInPlaceCommand, reviseSection } from "../intent/song";
import type { Pattern, ProjectDocument, SceneRole } from "../project-model/types";
import type { VocalProfile } from "./types";

export type PhraseReviseOutcome =
  { ok: true; patternId: string; pattern: Pattern; label: string; role: SceneRole } | { ok: false; error: string };

/**
 * VOICE-DRIVEN REVISE (V3) — the C3 targeted revise fed by analysis.
 *
 * Click a phrase on the vocal card → its scene role → the existing
 * reviseSection machinery (same seed, in-place swap, one undo). No song.ts
 * changes: this module only maps phrases to roles and delegates.
 *
 * Mapping: the peak phrase is the chorus, the first phrase opens (intro),
 * the last one closes (outro), everything else is a verse. No phrases (or
 * an out-of-range index) → null, and the caller falls back to text routing.
 */

export function phraseRole(profile: VocalProfile | null | undefined, phraseIndex: number): SceneRole | null {
  if (!profile || !profile.measured || profile.phrases.length === 0) return null;
  if (!Number.isInteger(phraseIndex) || phraseIndex < 0 || phraseIndex >= profile.phrases.length) return null;
  let peakIndex = 0;
  for (let i = 1; i < profile.phrases.length; i++) {
    if (profile.phrases[i].peakEnergy > profile.phrases[peakIndex].peakEnergy) peakIndex = i;
  }
  if (phraseIndex === peakIndex) return "chorus";
  if (phraseIndex === 0) return "intro";
  if (phraseIndex === profile.phrases.length - 1) return "outro";
  return "verse";
}

/**
 * Revise the section a phrase maps to (energy/density ±delta, same seed).
 * Returns the C3 outcome; apply with replacePatternInPlaceCommand for the
 * one-undo-step install (panel composes both calls).
 */
export function revisePhraseSection(
  doc: ProjectDocument,
  profile: VocalProfile | null | undefined,
  phraseIndex: number,
  attribute: "energy" | "density",
  delta: number,
): PhraseReviseOutcome {
  const role = phraseRole(profile, phraseIndex);
  if (!role) return { ok: false, error: "phrase has no section mapping — sing longer phrases first" };
  const outcome = reviseSection(doc, role, attribute, delta);
  if (!outcome.ok) return outcome;
  return { ...outcome, role };
}

export { replacePatternInPlaceCommand };
