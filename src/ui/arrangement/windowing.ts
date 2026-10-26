/**
 * THE WINDOW — which clips the arrangement lane renders, and how a live
 * gesture's clip stays in the DOM.
 *
 * The performance-cliff audit (finding C-4) found that the windowing memo
 * walked the ENTIRE clip list on every render: the window scan stops early
 * (the list is sorted by startBar), but the second pass — the one that keeps
 * the clips a live gesture owns mounted — had no way to stop, so it read every
 * clip of the document on every render, whether or not a gesture was running.
 *
 * The fix is the ADR 0063 pattern: index the list by id ONCE, then the forced
 * pass is a lookup per forced clip instead of a walk over the document.
 */

import type { ClipIndexEntry } from "./clip-indexes";

/** A clip and its position in the list it came from. */
export type WindowedClip<T> = ClipIndexEntry<T>;

/**
 * The clips to render: the ones the window covers, plus the ones a live
 * gesture owns even when they are outside it.
 *
 * `indexById` is the list indexed by id (`buildClipIndexById`). The forced pass
 * reads it, never the list.
 *
 * The entries keep their ORIGINAL index because `clips[index + 1]` renders the
 * transition mark to the next section — resolved against the full list, not the
 * window, or the last visible clip silently loses its "+" button.
 */
export function pickVisibleClips<T extends { id: string; startBar: number; lengthBars: number }>(
  list: readonly T[],
  indexById: ReadonlyMap<string, WindowedClip<T>>,
  firstBar: number,
  lastBar: number,
  forcedIds: ReadonlySet<string>,
): WindowedClip<T>[] {
  const out: WindowedClip<T>[] = [];
  const taken = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    const clip = list[i]!;
    if (clip.startBar > lastBar) break; // sorted by startBar
    if (clip.startBar + clip.lengthBars >= firstBar) {
      out.push({ clip, index: i });
      taken.add(i);
    }
  }
  // The forced pass: a lookup per forced clip, NOT a walk over the list. The
  // gesture owns a handful of clips; the document holds thousands.
  for (const id of forcedIds) {
    const entry = indexById.get(id);
    if (entry && !taken.has(entry.index)) out.push(entry);
  }
  return out.sort((a, b) => a.index - b.index);
}
