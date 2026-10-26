/**
 * THE CLIP INDEXES — what the arrangement render builds ONCE per clip list
 * instead of once per visible clip.
 *
 * The performance-cliff audit (finding C-3/C-4) found the same shape twice in
 * the arrangement render: per-item work that scans the whole collection.
 *
 *   - The comp-source take number was computed per visible audio clip, and
 *     each computation built a `Set` over EVERY audio clip in the document.
 *   - The wall-clock length of each visible audio clip rebuilt the whole scene
 *     span map (a filter, a `scenes.find` per clip and a sort over every scene
 *     clip).
 *   - The windowing memo's forced-id pass walked the ENTIRE clip list on every
 *     render, even when the gesture that owns a clip was not active.
 *
 * ADR 0063 is the pattern: build the index once, outside the loop, and
 * invalidate it by identity. The document-level index there is a `WeakMap`
 * keyed by the document; these are keyed by the clip LIST, because the
 * arrangement's lists are sorted copies whose identity is what changes.
 *
 * The rules ADR 0063 fixed and these keep:
 *   - FIRST match wins, exactly like the `Array.prototype.find` they replace.
 *   - Derived data, never a second source of truth: nothing writes through an
 *     index, and an index is only ever read.
 */

/** A clip and its position in the list it came from. */
export interface ClipIndexEntry<T> {
  clip: T;
  index: number;
}

/**
 * Clip by id, first match wins — the same answer `list.find(...)` gave, in
 * O(1) instead of O(n).
 */
export function buildClipIndexById<T extends { id: string }>(
  list: readonly T[],
): ReadonlyMap<string, ClipIndexEntry<T>> {
  const index = new Map<string, ClipIndexEntry<T>>();
  for (let i = 0; i < list.length; i++) {
    const clip = list[i]!;
    if (!index.has(clip.id)) index.set(clip.id, { clip, index: i });
  }
  return index;
}

/**
 * The part of a take group the arrangement render reads. Structural, so the
 * project's `AudioTakeGroup` satisfies it without a cast.
 */
export interface TakeGroupLike {
  id: string;
  compTakeId?: string;
}

/**
 * The comp-source take numbering: which take of a take group a comp clip is
 * sliced from, numbered from 1 in the order the takes appear in the document.
 */
export interface CompTakeOrder {
  /**
   * The take group with this id — first match wins, exactly like the
   * `takeGroups.find(...)` it replaces. `undefined` when there is no group.
   */
  groupOf(takeGroupId: string | undefined): TakeGroupLike | undefined;
  /**
   * The 1-based position of `takeId` among the comp-source takes of
   * `takeGroupId`, or 0 when the take is not one of them.
   */
  numberOf(takeGroupId: string | undefined, takeId: string | undefined): number;
}

/**
 * Build the comp-source take order ONCE per (audio clips, take groups).
 *
 * The rule it replaces, per visible clip: take every audio clip in the same
 * take group, drop the group's own comp take, keep the distinct take ids in
 * first-appearance order, and ask where this clip's `compSourceTakeId` sits in
 * that list. The group id may be absent, in which case the ungrouped clips
 * are the group — so the key is the raw id, `undefined` included.
 */
export function buildCompTakeOrderIndex(
  audioClips: ReadonlyArray<{ takeGroupId?: string; takeId?: string }>,
  takeGroups: ReadonlyArray<TakeGroupLike>,
): CompTakeOrder {
  // First match wins, like the `takeGroups.find(...)` this replaces.
  const groupById = new Map<string, TakeGroupLike>();
  for (const group of takeGroups) {
    if (!groupById.has(group.id)) groupById.set(group.id, group);
  }

  const orderByGroup = new Map<string | undefined, Map<string, number>>();
  for (const clip of audioClips) {
    if (!clip.takeId) continue;
    // A clip with no take group has no group, so nothing is excluded for it.
    const excluded = clip.takeGroupId === undefined ? undefined : groupById.get(clip.takeGroupId)?.compTakeId;
    if (clip.takeId === excluded) continue;
    let order = orderByGroup.get(clip.takeGroupId);
    if (!order) {
      order = new Map();
      orderByGroup.set(clip.takeGroupId, order);
    }
    if (!order.has(clip.takeId)) order.set(clip.takeId, order.size + 1);
  }

  return {
    groupOf(takeGroupId: string | undefined): TakeGroupLike | undefined {
      if (takeGroupId === undefined) return undefined;
      return groupById.get(takeGroupId);
    },
    numberOf(takeGroupId: string | undefined, takeId: string | undefined): number {
      if (!takeId) return 0;
      return orderByGroup.get(takeGroupId)?.get(takeId) ?? 0;
    },
  };
}
