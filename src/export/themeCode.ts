import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { THEME_PRESETS, type ThemeState } from "../ui/theme";

/**
 * Theme share codes: a user's look — palette, accent hue, size, density,
 * motion — compressed into a portable token. The last piece of the
 * "everything is shareable" story: project (share link) → kit (PFKIT1:) →
 * keymap (PFBIND1:) → theme (PFTHM1:).
 *
 * Codes are UNTRUSTED input: decoding validates every field (unknown presets
 * fall back to the default, numbers clamp into their ranges), so a tampered
 * token yields at worst a legal theme.
 */

export const THEME_CODE_PREFIX = "PFTHM1:";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function encodeThemeCode(state: ThemeState): string {
  return THEME_CODE_PREFIX + compressToEncodedURIComponent(JSON.stringify(state));
}

export function decodeThemeCode(code: string): ThemeState | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(THEME_CODE_PREFIX)) return null;
  try {
    const json = decompressFromEncodedURIComponent(trimmed.slice(THEME_CODE_PREFIX.length));
    if (!json) return null;
    const raw = JSON.parse(json) as Partial<ThemeState>;
    const known = THEME_PRESETS.some((p) => p.id === raw.preset);
    return {
      preset: known ? (raw.preset as string) : THEME_PRESETS[0].id,
      hue: typeof raw.hue === "number" && Number.isFinite(raw.hue) ? clamp(Math.round(raw.hue), 0, 359) : null,
      scale: typeof raw.scale === "number" && Number.isFinite(raw.scale) ? clamp(raw.scale, 0.8, 1.3) : 1,
      compact: raw.compact === true,
      reduceMotion: raw.reduceMotion === true,
    };
  } catch {
    return null;
  }
}
