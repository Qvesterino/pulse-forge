/**
 * REZONANS — project musical context resolution (host side).
 *
 * The bridge between `doc.key` / `doc.arrangement.chords` and the audio
 * thread. Extracted from `AudioEngine` as a pure function so it is testable
 * without an AudioContext — the engine method is now a one-line call.
 *
 * WHY IT LIVES HERE AND NOT IN THE WORKLET: masks are computed from the same
 * `SCALE_INTERVALS` / `CHORD_INTERVALS` tables the piano roll reads, so the
 * worklet carries no scale table at all. That is what makes an arbitrary
 * user-editable scale a parameter change rather than a worklet rebuild
 * (ADR 0038 §4.3d).
 *
 * Safe degradation is deliberate — this runs on the audio-chain build path,
 * where a throw would take down every effect on the track:
 *   - no `doc.key`      → chromatic (all twelve pitch classes allowed)
 *   - unparseable key   → chromatic
 *   - empty scale       → chromatic
 *   - malformed chord   → skipped, not thrown
 */

import type { HarmonyContextInit } from "../effects/types";
import { CHORD_INTERVALS } from "../project-model/chords";
import type { ChordQuality } from "../project-model/chords";
import { parseKey, SCALE_INTERVALS } from "../project-model/scales";
import type { MusicalKey } from "../project-model/types";

/** All twelve pitch classes allowed — the "no key set" behaviour. */
export const CHROMATIC_MASK = 0xfff;

/** Build a 12-bit pitch-class mask from a root and a list of intervals. */
export function maskFromIntervals(rootPc: number, intervals: readonly number[] | undefined): number {
  if (!intervals || intervals.length === 0) return 0;
  let mask = 0;
  for (const interval of intervals) {
    // Parentheses are load-bearing: `%` binds tighter than `<<`, so
    // `1 << x % 12` parses as `(1 << x) % 12` and sets a wrong bit.
    mask |= 1 << ((rootPc + interval) % 12);
  }
  return mask;
}

/** Scale mask for a `MusicalKey`; chromatic when the key is absent or invalid. */
export function scaleMaskForKey(key: MusicalKey | undefined): { rootPc: number; mask: number } {
  if (!key) return { rootPc: 0, mask: CHROMATIC_MASK };
  const parsed = parseKey(key);
  if (!parsed) return { rootPc: 0, mask: CHROMATIC_MASK };
  const mask = maskFromIntervals(parsed.root, SCALE_INTERVALS[parsed.scaleType]);
  return { rootPc: parsed.root, mask: mask === 0 ? CHROMATIC_MASK : mask };
}

/** Chord mask for one chord, or 0 when the quality is unknown. */
export function chordMaskFor(rootPc: number, quality: ChordQuality | undefined): number {
  return maskFromIntervals(rootPc, quality ? CHORD_INTERVALS[quality] : undefined);
}

interface ChordLike {
  startBar?: number;
  lengthBars?: number;
  root?: number;
  quality?: ChordQuality;
}

/**
 * Resolve the full musical context for one project document. Returns
 * `undefined` only when there is no document at all, so an effect always gets
 * a usable context (chromatic, no chords) rather than having to guess.
 */
export function resolveHarmonyContext(
  doc: { key?: MusicalKey; arrangement?: { chords?: ChordLike[] } } | undefined | null,
): HarmonyContextInit | undefined {
  if (!doc) return undefined;

  const { rootPc, mask } = scaleMaskForKey(doc.key);

  const chords = (doc.arrangement?.chords ?? [])
    .filter((c) => c && Number.isFinite(c.startBar) && Number.isFinite(c.lengthBars) && (c.lengthBars ?? 0) > 0)
    .map((c) => ({
      startBar: c.startBar!,
      lengthBars: c.lengthBars!,
      rootPc: ((Math.round(c.root ?? 0) % 12) + 12) % 12,
      chordMask: chordMaskFor(c.root ?? 0, c.quality),
    }))
    .sort((a, b) => a.startBar - b.startBar);

  return { keyRootPc: rootPc, scaleMask: mask, chords };
}
