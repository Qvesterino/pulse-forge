import { describe, expect, it } from "vitest";
import { buildFamilyTree } from "../src/gallery/familyTree";
import type { GalleryItem } from "../src/gallery/galleryApi";

/** Minimal feed item — only the fields the tree builder reads. */
function item(overrides: Partial<GalleryItem> & Pick<GalleryItem, "id" | "title" | "createdAt">): GalleryItem {
  return {
    code: `code-${overrides.id}`,
    author: "tester",
    tags: [],
    ...overrides,
  } as GalleryItem;
}

describe("family tree builder (F4 tree viz)", () => {
  it("collects every generation and branch below the root, children newest-first", () => {
    const root = item({ id: "g1", docId: "doc-1", title: "Root", createdAt: "2026-01-01" });
    const a = item({ id: "g2", docId: "doc-2", parentDocId: "doc-1", title: "A", createdAt: "2026-01-02" });
    const b = item({ id: "g3", docId: "doc-3", parentDocId: "doc-1", title: "B", createdAt: "2026-01-03" });
    const a1 = item({ id: "g4", docId: "doc-4", parentDocId: "doc-2", title: "A1", createdAt: "2026-01-04" });
    const tree = buildFamilyTree([b, root, a1, a], a1);

    expect(tree.rootId).toBe("g1");
    // DFS pre-order, children NEWEST first: B (01-03) branch renders before A (01-02).
    expect(tree.nodes.map((n) => n.item.id)).toEqual(["g1", "g3", "g2", "g4"]);
    expect(tree.nodes.map((n) => n.depth)).toEqual([0, 1, 1, 2]);
    expect(tree.edges).toEqual([
      { from: "g1", to: "g3", viaLegacy: false },
      { from: "g1", to: "g2", viaLegacy: false },
      { from: "g2", to: "g4", viaLegacy: false },
    ]);
  });

  it("joins pre-lineage remixes through the legacy gallery-parent chain (backfill)", () => {
    // An OLD remix pair: the child carries only the legacy gallery parentId —
    // no doc lineage existed when it was published.
    const oldParent = item({ id: "old-1", docId: "odoc-1", title: "Old root", createdAt: "2025-01-01" });
    const oldChild = item({
      id: "old-2",
      docId: "odoc-2",
      parentId: "old-1",
      title: "Old remix",
      createdAt: "2025-02-01",
    });
    const tree = buildFamilyTree([oldParent, oldChild], oldChild);
    expect(tree.rootId).toBe("old-1");
    expect(tree.nodes.map((n) => n.item.id)).toEqual(["old-1", "old-2"]);
    expect(tree.edges[0]).toEqual({ from: "old-1", to: "old-2", viaLegacy: true });
    expect(tree.nodes[1].viaLegacy).toBe(true);
  });

  it("chains mixed eras: legacy child → doc-lineage grandchild", () => {
    // Old root, old remix (legacy edge), then a NEW fork of that remix
    // (doc edge pointing at the old child's doc id) — one tree, two eras.
    const root = item({ id: "r", docId: "rdoc", title: "R", createdAt: "2025-01-01" });
    const mid = item({ id: "m", docId: "mdoc", parentId: "r", title: "M", createdAt: "2025-02-01" });
    const leaf = item({ id: "l", docId: "ldoc", parentDocId: "mdoc", title: "L", createdAt: "2026-03-01" });
    const tree = buildFamilyTree([root, mid, leaf], leaf);
    expect(tree.nodes.map((n) => n.item.id)).toEqual(["r", "m", "l"]);
    expect(tree.edges.map((e) => [e.from, e.to, e.viaLegacy])).toEqual([
      ["r", "m", true],
      ["m", "l", false],
    ]);
  });

  it("treats an orphan as its own root and survives cycles", () => {
    const orphan = item({ id: "o", title: "Orphan", createdAt: "2026-01-01" });
    const lone = buildFamilyTree([orphan], orphan);
    expect(lone.rootId).toBe("o");
    expect(lone.nodes).toHaveLength(1);

    // A pathological mutual-parent loop must not hang or duplicate.
    const x = item({ id: "x", docId: "xdoc", parentDocId: "ydoc", title: "X", createdAt: "2026-01-01" });
    const y = item({ id: "y", docId: "ydoc", parentDocId: "xdoc", title: "Y", createdAt: "2026-01-02" });
    const cycled = buildFamilyTree([x, y], x);
    expect(new Set(cycled.nodes.map((n) => n.item.id)).size).toBe(cycled.nodes.length);
  });

  it("the current node is part of the tree even when its parent is unpublished", () => {
    // The parent doc id points at a beat that was never published — the
    // branch starts at the child, honestly shallow.
    const child = item({ id: "c", docId: "cdoc", parentDocId: "ghost-doc", title: "C", createdAt: "2026-01-01" });
    const tree = buildFamilyTree([child], child);
    expect(tree.rootId).toBe("c");
    expect(tree.nodes.map((n) => n.item.id)).toEqual(["c"]);
    expect(tree.edges).toEqual([]);
  });
});
