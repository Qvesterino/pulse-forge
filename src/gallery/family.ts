import type { GalleryItem } from "./galleryApi";

/**
 * Remix-DNA family tree over a gallery feed — "rodokmeň beatov".
 *
 * Joins items by DOC lineage (`parentDocId`/`rootDocId` extracted server-side
 * from the schema-v3 `lineage` inside each share code), not by the older
 * gallery-side `parentId` remix chain. A child whose parent was never
 * published still lists (its ancestor walk simply ends early). Pure —
 * the card renders ancestors ↑ and children ↓ from one call.
 */

export interface BeatFamily {
  /** Root-first ancestor chain (may be partial when middles are unpublished). */
  ancestors: GalleryItem[];
  /** Direct published children, newest first (feed order). */
  children: GalleryItem[];
}

const WALK_CAP = 32;

/** Items of one family by doc id — the join key for both directions. */
function byDocId(items: readonly GalleryItem[]): Map<string, GalleryItem> {
  const map = new Map<string, GalleryItem>();
  for (const item of items) {
    if (typeof item.docId === "string" && !map.has(item.docId)) map.set(item.docId, item);
  }
  return map;
}

export function buildFamily(items: readonly GalleryItem[], item: GalleryItem): BeatFamily {
  const index = byDocId(items);
  const ancestors: GalleryItem[] = [];
  const seen = new Set<string>([item.id]);
  let cursor: string | null | undefined = item.parentDocId;
  for (let guard = 0; guard < WALK_CAP && typeof cursor === "string"; guard++) {
    const parent = index.get(cursor);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    ancestors.unshift(parent);
    cursor = parent.parentDocId;
  }
  const ownDocId = typeof item.docId === "string" ? item.docId : null;
  const children =
    ownDocId === null
      ? []
      : items.filter((candidate) => candidate.id !== item.id && candidate.parentDocId === ownDocId);
  return { ancestors, children };
}
