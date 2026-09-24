import type { VocalProfile } from "./types";

/**
 * VOCAL-DRIVEN SONG FORM (V2) — the singer's phrasing bends the arrangement.
 *
 * The genre form stays in charge (sections, transitions, markers); the voice
 * only NUDGES per-section energy/density toward what the take actually does
 * in that bar span: sung peaks lift their section, pauses let it breathe.
 * No vocal coverage (or a flat 0.5 mean) → zero adjustment — the song builds
 * exactly as before (bit-identical without a profile).
 */

export interface VocalSectionAdjust {
  energy: number;
  density: number;
}

/** Mean energyCurve over [startBar, startBar + bars), null when uncovered. */
export function vocalSpanEnergy(
  profile: VocalProfile | null | undefined,
  startBar: number,
  bars: number,
): number | null {
  if (!profile || !profile.measured || profile.energyCurve.length === 0 || bars <= 0) return null;
  const slice = profile.energyCurve.slice(Math.max(0, startBar), startBar + bars);
  if (slice.length === 0) return null;
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

/**
 * Slider adjustments for one section (additive, clamped by the caller via
 * normalizeIntent). Identity at vocal mean 0.5 — silence lets the section
 * breathe (−0.3/−0.2), peaks lift it (+0.3/+0.2).
 */
export function vocalSectionAdjust(
  profile: VocalProfile | null | undefined,
  startBar: number,
  bars: number,
): VocalSectionAdjust {
  const mean = vocalSpanEnergy(profile, startBar, bars);
  if (mean === null) return { energy: 0, density: 0 };
  const centered = mean - 0.5;
  return { energy: centered * 0.6, density: centered * 0.4 };
}
