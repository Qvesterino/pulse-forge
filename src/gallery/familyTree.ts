import type { GalleryItem } from "./galleryApi";

/**
 * Full family TREE over a gallery feed — F4 "tree viz" (ROADMAP: gallery
 * flywheel). `buildFamily` gives the linear view (ancestors ↑, direct
 * children ↓); this walks the WHOLE graph so a tree renders every branch
 * and generation at once.
 *
 * Two edge eras join into one tree (the "backfill" of pre-lineage remixes
 * without touching stored data):
 *  - doc edge (schema v3): child.parentDocId === parent.docId
 *  - legacy edge (old REMIX flow): child.parentId === parent.id
 * A parent resolution prefers the doc edge and falls back to the legacy
 * chain, so old→old, old→new and new→old chains all connect.
 *
 * Pure — the overlay renders whatever this returns. Unpublished middles
 * simply end their branch at the last published node; cycles and absurd
 * fan-outs are capped, never thrown.
 */

export interface FamilyTreeNode {
  item: GalleryItem;
  /** Generations below the collected root (root = 0). */
  depth: number;
  /** Joined through the legacy gallery-parent chain, not doc lineage. */
  viaLegacy: boolean;
}

export interface FamilyTreeEdge {
  /** item.id of the parent node. */
  from: string;
  /** item.id of the child node. */
  to: string;
  viaLegacy: boolean;
}

export interface FamilyTree {
  /** DFS pre-order (children newest-first) — render order, parents before children. */
  nodes: FamilyTreeNode[];
  edges: FamilyTreeEdge[];
  /** item.id of the collected root (null when the item is an orphan). */
  rootId: string | null;
}

const MAX_NODES = 256;
const WALK_CAP = 64;

function byId(items: readonly GalleryItem[]): Map<string, GalleryItem> {
  const map = new Map<string, GalleryItem>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/** First published item carrying this doc id. */
function byDocId(items: readonly GalleryItem[]): Map<string, GalleryItem> {
  const map = new Map<string, GalleryItem>();
  for (const item of items) {
    if (typeof item.docId === "string" && item.docId !== "" && !map.has(item.docId)) map.set(item.docId, item);
  }
  return map;
}

/** The published parent of one item across both edge eras — null when orphan. */
function resolveParent(
  item: GalleryItem,
  ids: Map<string, GalleryItem>,
  docs: Map<string, GalleryItem>,
): { parent: GalleryItem; viaLegacy: boolean } | null {
  if (typeof item.parentDocId === "string" && item.parentDocId !== "") {
    const parent = docs.get(item.parentDocId);
    if (parent && parent.id !== item.id) return { parent, viaLegacy: false };
  }
  if (typeof item.parentId === "string" && item.parentId !== "") {
    const parent = ids.get(item.parentId);
    if (parent && parent.id !== item.id) return { parent, viaLegacy: true };
  }
  return null;
}

function newerFirst(a: GalleryItem, b: GalleryItem): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

export function buildFamilyTree(items: readonly GalleryItem[], current: GalleryItem): FamilyTree {
  const ids = byId(items);
  const docs = byDocId(items);

  // 1) Walk UP from the current item to the family root (both edge types).
  const lineageUp: GalleryItem[] = [];
  const upSeen = new Set<string>([current.id]);
  let cursor: GalleryItem | null = current;
  for (let guard = 0; guard < WALK_CAP; guard++) {
    const resolved: { parent: GalleryItem; viaLegacy: boolean } | null = cursor
      ? resolveParent(cursor, ids, docs)
      : null;
    if (!resolved || upSeen.has(resolved.parent.id)) break;
    upSeen.add(resolved.parent.id);
    lineageUp.unshift(resolved.parent);
    cursor = resolved.parent;
  }
  const root = lineageUp.length > 0 ? lineageUp[0] : current;

  // 2) Collect the whole subtree below the root, DFS pre-order.
  const nodes: FamilyTreeNode[] = [];
  const edges: FamilyTreeEdge[] = [];
  const seen = new Set<string>([root.id]);
  const visit = (item: GalleryItem, depth: number, viaLegacy: boolean) => {
    nodes.push({ item, depth, viaLegacy });
    if (nodes.length >= MAX_NODES) return;
    const children = items
      .filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        const resolved = resolveParent(candidate, ids, docs);
        return resolved !== null && resolved.parent.id === item.id;
      })
      .sort(newerFirst);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const resolved = resolveParent(child, ids, docs)!;
      edges.push({ from: item.id, to: child.id, viaLegacy: resolved.viaLegacy });
      visit(child, depth + 1, resolved.viaLegacy);
    }
  };
  visit(root, 0, false);

  return { nodes, edges, rootId: root.id };
}
