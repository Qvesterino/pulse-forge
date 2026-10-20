/**
 * PLUGIN AUDIT — instrument audition fixture (2026-10-24).
 *
 * The audit auditions every instrument with ONE note. A fixed 0.35 s tap
 * cannot audition an instrument whose ATTACK is longer than the tap: the
 * envelope never leaves the attack, so the render measures the attack slope
 * instead of the instrument's operating level, and a perfectly healthy
 * instrument is reported as broken.
 *
 * Measured: Spectral Pad (0.6 s attack) reached -68.5 dBFS and Texture Synth
 * (0.5 s attack) -84.0 dBFS under a 0.35 s tap, while the same notes held
 * long enough reached -16.6 dBFS and -20.1 dBFS. Both were listed as silent
 * instruments. The rule lives in its own module so a node test can pin it:
 * the audit module itself pulls in the whole engine and only runs in a
 * browser.
 */

/** The tap length every instrument gets, unless its attack needs longer. */
export const AUDITION_NOTE_SEC = 0.35;

/** Hold past the attack so the note is released at the operating level. */
const ATTACK_MARGIN_SEC = 0.15;

/**
 * How long the audition note must be held for an instrument with these
 * default parameters.
 *
 * The attack must COMPLETE, otherwise the render never contains the level
 * the instrument actually plays at.
 */
export function auditionNoteSec(defaults: Record<string, number>): number {
  const attack = Math.max(0, defaults.attack ?? 0);
  return Math.max(AUDITION_NOTE_SEC, attack + ATTACK_MARGIN_SEC);
}
