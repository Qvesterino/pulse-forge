import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import type { KitPadCapture } from "../commands/commands";

/**
 * Kit share codes: a drum-kit pad mapping compressed into a portable token —
 * the kit analogue of project share codes. Paste into any Pulse Forge to
 * install the kit into the user kit library.
 *
 * Codes are UNTRUSTED input: decoding validates and clamps every field, so a
 * tampered token can at worst produce a weird-but-legal kit.
 */

export const KIT_CODE_PREFIX = "PFKIT1:";

export interface SharedKit {
  name: string;
  pads: KitPadCapture[];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fallback;

export function encodeKitCode(name: string, pads: SharedKit["pads"]): string {
  return KIT_CODE_PREFIX + compressToEncodedURIComponent(JSON.stringify({ name, pads }));
}

export function decodeKitCode(code: string): SharedKit | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(KIT_CODE_PREFIX)) return null;
  try {
    const json = decompressFromEncodedURIComponent(trimmed.slice(KIT_CODE_PREFIX.length));
    if (!json) return null;
    const raw = JSON.parse(json) as { name?: unknown; pads?: unknown };
    if (typeof raw.name !== "string" || !Array.isArray(raw.pads) || raw.pads.length === 0) return null;
    const name = raw.name.slice(0, 60);
    const pads: SharedKit["pads"] = [];
    const seen = new Set<number>();
    for (const p of raw.pads as Record<string, unknown>[]) {
      const idx = num(p.idx, -1, 0, 15);
      if (!Number.isInteger(idx) || seen.has(idx)) continue;
      seen.add(idx);
      pads.push({
        idx,
        assetId: typeof p.assetId === "string" && p.assetId.length <= 200 ? p.assetId : null,
        synth: null,
        gain: num(p.gain, 1, 0, 2),
        pan: num(p.pan, 0, -1, 1),
        chokeGroup:
          p.chokeGroup === null || p.chokeGroup === undefined ? null : Math.round(num(p.chokeGroup, 0, 0, 16)),
        pitch: num(p.pitch, 0, -36, 36),
      });
    }
    if (pads.length === 0) return null;
    return { name, pads };
  } catch {
    return null;
  }
}
