import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import type { PadKeyMap } from "../ui/padKeys";
import { normalizePadKeyMap } from "../ui/padKeys";

/**
 * BINDS share codes: the 16 pad-key bindings compressed into a portable
 * token — same pattern as kit codes (PFKIT1:). Paste into any Pulse Forge to
 * install the sender's pad keymap (AZERTY/SK layouts travel with it).
 *
 * Codes are UNTRUSTED input: decoding runs through the same normalization as
 * the store (unique printable keys, reserved rejected, defaults fill gaps),
 * so a tampered token yields at worst a legal keymap.
 */

export const BINDS_CODE_PREFIX = "PFBIND1:";

export function encodeBindsCode(keys: PadKeyMap): string {
  return BINDS_CODE_PREFIX + compressToEncodedURIComponent(JSON.stringify({ keys }));
}

export function decodeBindsCode(code: string): PadKeyMap | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(BINDS_CODE_PREFIX)) return null;
  try {
    const json = decompressFromEncodedURIComponent(trimmed.slice(BINDS_CODE_PREFIX.length));
    if (!json) return null;
    const parsed = JSON.parse(json) as { keys?: unknown };
    if (!Array.isArray(parsed.keys)) return null;
    return normalizePadKeyMap(parsed.keys);
  } catch {
    return null;
  }
}
