/**
 * The release brand rule: a legacy public brand label must never appear in
 * SHIPPED USER-FACING COPY.
 *
 * The rule draws a line between the two things that carry the old names:
 *
 *   - USER-FACING COPY — display names, glyph legends, search keywords.
 *     "KYX (Pulse Forge)", "ZYVO (VocalForge DAW)", "Pulse Forge" as a
 *     displayName, "vocalforge" as a keyword. These are words a person
 *     READS. A shipped artifact that carries them presents the product
 *     under its old name, and the release must not ship that.
 *
 *   - IDENTIFIERS — protocol keys, route slugs and repository slugs. The
 *     ecosystem interop depends on them: appId "pulse_forge", appId
 *     "vocalforge_daw", the mounted route "/pulse-forge", the external
 *     repo target "repo://vocalforge-daw". Renaming one of those breaks a
 *     live edge between apps; it is not a brand statement to a user.
 *
 * So the pattern matches the label only when it stands ALONE as words:
 * a hyphen or an underscore glues the name to an identifier, and a glued
 * form is an identifier, not a label.
 *
 * Shared by the preflight runner and its spec so the rule cannot drift.
 */

/**
 * A legacy public brand label as a standalone word (or word pair).
 *
 * - `pulse\s+forge` — the spaced legacy name ("Pulse Forge").
 * - `pulseforge`   — the joined legacy word ("PulseForge").
 * - `vocalforge`   — the other product's legacy family name.
 *
 * The lookarounds treat `-` and `_` as identifier glue: a match must not
 * be preceded or followed by a word character, a hyphen or an underscore.
 */
export const LEGACY_PUBLIC_LABEL = /(?<![\w-])(?:pulse\s+forge|pulseforge|vocalforge)(?![\w-])/i;

/** The first legacy public brand label in `text`, or null. */
export function findLegacyPublicBrandLabel(text) {
  const match = LEGACY_PUBLIC_LABEL.exec(text);
  return match ? match[0] : null;
}

/** True when `text` carries a legacy public brand label. */
export function hasLegacyPublicBrandLabel(text) {
  return findLegacyPublicBrandLabel(text) !== null;
}
