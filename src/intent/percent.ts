/**
 * PERCENT parser — "o 10 %", "+10 %", "by 10 percent", "o polovicu".
 *
 * Shared by fader ("zvýš basu o 10 %") and targeted-effect ("viac delayu
 * o 20 %") intents. An explicit number always beats vibe words
 * (trochu/huge) at apply time — callers treat the return as "percent of the
 * knob/track range in the parsed direction".
 *
 * Pure, EN+SK, de-accented matching like the rest of the intent layer.
 * Returns 1..100, or null when no percent is named ("140 bpm", "16-bar" and
 * "loudness na −9" carry numbers but no percent — all safe).
 */

/** Word fractions → percent (checked before digits). */
const FRACTIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bpolovicu\b|\bpolovinu\b|\bhalf\b/, 50],
  [/\btretinu\b|\bthird\b/, 33],
  [/\bstvrtinu\b|\bquarter\b/, 25],
  [/dvojnasob\w*|\bdouble\b|\btwice\b|\b2x\b/, 100],
];

/** Explicit digits: "10 %", "+10 %", "o 10 percent", "10 percent". */
const DIGITS = /([+-]?\d{1,3})\s*(?:%|percent\w*|procent\w*|pct\b)/;

export function parsePercent(text: string): number | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  for (const [pattern, value] of FRACTIONS) {
    if (pattern.test(lower)) return value;
  }
  const match = DIGITS.exec(lower);
  if (!match) return null;
  const value = Math.abs(Number(match[1]));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(100, Math.round(value));
}
