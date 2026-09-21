/**
 * Pad-key DATA — the pure half of the QWERTY pad-binding system, split from
 * ui/padKeys.ts (cross-platform campaign GOAL 02): the default grid,
 * reserved-key set and the normalizer, with zero React / DOM / storage
 * imports, so share-code encoders (BINDS / PACK) and future non-browser
 * hosts consume them. The reactive + persisted half lives in ui/padKeys.ts,
 * which re-exports this module's API for backward compatibility.
 */

export const DEFAULT_PAD_KEYS = [
  "q",
  "w",
  "e",
  "r",
  "t",
  "y",
  "u",
  "i",
  "a",
  "s",
  "d",
  "f",
  "g",
  "h",
  "j",
  "k",
] as const;

/** Keys that must never be bound (modifiers, navigation, transport, help). */
export const RESERVED = new Set([
  " ",
  "escape",
  "enter",
  "tab",
  "backspace",
  "delete",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "shift",
  "control",
  "alt",
  "meta",
  "capslock",
  "contextmenu",
  ",",
  ".",
  "?",
  "+",
  "-",
]);

export type PadKeyMap = string[];

export function normalizePadKeyMap(map: unknown): PadKeyMap {
  const source = Array.isArray(map) ? map : [];
  const out: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < 16; i++) {
    const raw = typeof source[i] === "string" ? source[i].toLowerCase() : "";
    // One printable character, not reserved, not already used by another slot.
    if (raw.length === 1 && !RESERVED.has(raw) && !used.has(raw)) {
      out.push(raw);
      used.add(raw);
    } else {
      // Fall back to the default key for this slot when free.
      const fallback = DEFAULT_PAD_KEYS[i];
      if (fallback && !used.has(fallback)) {
        out.push(fallback);
        used.add(fallback);
      } else {
        out.push("");
      }
    }
  }
  return out;
}
