import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { normalizeLayoutState, type LayoutState } from "../shared/layout-data";

/**
 * Layout share codes: a user's entire look AND geometry — palette, accent,
 * scales, density, dock shape, inspector width — compressed into one portable
 * token (ADR 0036).
 *
 * This supersedes PFTHM1 (`export/themeCode.ts`) for new shares: PFTHM1 carries
 * colors and motion only, so a shared theme landed on a machine whose layout
 * had nothing to do with the sender's. PFTHM1 keeps decoding so existing links
 * stay valid.
 *
 * Codes are UNTRUSTED input. Everything runs through
 * `normalizeLayoutState`, which clamps every number, validates every enum, caps
 * the color-override map and drops malformed token names — so a tampered token
 * yields at worst a legal layout, never a thrown render.
 */

export const LAYOUT_CODE_PREFIX = "PFLYT1:";

export function encodeLayoutCode(state: LayoutState): string {
  // Encode the NORMALIZED state: a code built from a dirty in-memory object
  // would otherwise smuggle illegal values past the decoder's clamps.
  return LAYOUT_CODE_PREFIX + compressToEncodedURIComponent(JSON.stringify(normalizeLayoutState(state)));
}

export function decodeLayoutCode(code: string): LayoutState | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(LAYOUT_CODE_PREFIX)) return null;
  try {
    const json = decompressFromEncodedURIComponent(trimmed.slice(LAYOUT_CODE_PREFIX.length));
    if (!json) return null;
    const raw = JSON.parse(json) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return normalizeLayoutState(raw as Partial<LayoutState>);
  } catch {
    return null;
  }
}
