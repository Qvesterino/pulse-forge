import type { GenerativeVariation } from "./resample";

/**
 * CF-20 — the uncommitted resample-variation shelf.
 *
 * The A/B/C/D variations live only in Inspector component state, and the
 * effect that resets per-track drafts wiped them on every TRACK SWITCH —
 * switching away to compare was the one way to lose four uncommitted takes
 * silently. The variations carry Float32Array PCM, so this is a SESSION
 * shelf (module-level, keyed per track), not a localStorage one: switching
 * tracks preserves the takes, a reload legitimately does not.
 *
 * Bounded like every other in-memory cache: the eight most recently shelved
 * tracks survive; older entries are dropped.
 */
const SHELF_LIMIT = 8;
const shelf = new Map<string, GenerativeVariation[]>();

export function shelfVariations(trackId: string, variations: GenerativeVariation[]): void {
  if (variations.length === 0) return;
  shelf.delete(trackId);
  shelf.set(trackId, variations);
  while (shelf.size > SHELF_LIMIT) {
    const oldest = shelf.keys().next().value;
    if (oldest === undefined) break;
    shelf.delete(oldest);
  }
}

/** The shelf is a POP: the caller takes ownership of the stored takes. */
export function takeShelvedVariations(trackId: string): GenerativeVariation[] | null {
  const stored = shelf.get(trackId);
  if (!stored) return null;
  shelf.delete(trackId);
  return stored;
}

export function clearVariationShelf(): void {
  shelf.clear();
}
