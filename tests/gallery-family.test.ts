import { describe, it, expect } from "vitest";
import { buildFamily } from "../src/gallery/family";
import type { GalleryItem } from "../src/gallery/galleryApi";

function item(overrides: Partial<GalleryItem> & { id: string }): GalleryItem {
  return {
    title: overrides.id,
    author: "tester",
    tags: [],
    code: "code",
    bpm: 124,
    projectName: "Test",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildFamily (Remix-DNA tree)", () => {
  it("walks ancestors root-first and lists direct children", () => {
    const root = item({ id: "g-root", docId: "doc-root", depth: 0 });
    const mid = item({ id: "g-mid", docId: "doc-mid", parentDocId: "doc-root", rootDocId: "doc-root", depth: 1 });
    const leaf = item({ id: "g-leaf", docId: "doc-leaf", parentDocId: "doc-mid", rootDocId: "doc-root", depth: 2 });
    const sibling = item({ id: "g-sib", docId: "doc-sib", parentDocId: "doc-mid", rootDocId: "doc-root", depth: 2 });
    const other = item({ id: "g-other", docId: "doc-other" });
    const feed = [leaf, sibling, other, mid, root]; // feed order irrelevant
    expect(buildFamily(feed, leaf)).toEqual({ ancestors: [root, mid], children: [] });
    const midFam = buildFamily(feed, mid);
    expect(midFam.ancestors).toEqual([root]);
    expect(midFam.children.map((c) => c.id).sort()).toEqual(["g-leaf", "g-sib"]);
    expect(buildFamily(feed, root)).toEqual({ ancestors: [], children: [mid] });
  });

  it("ends the ancestor walk early when the parent is unpublished", () => {
    const orphan = item({ id: "g-orphan", docId: "doc-orphan", parentDocId: "doc-ghost", depth: 3 });
    expect(buildFamily([orphan], orphan)).toEqual({ ancestors: [], children: [] });
  });

  it("items without doc ids have no family", () => {
    const legacy = item({ id: "g-legacy" });
    expect(buildFamily([legacy], legacy)).toEqual({ ancestors: [], children: [] });
  });

  it("breaks ancestor cycles instead of looping", () => {
    const a = item({ id: "g-a", docId: "doc-a", parentDocId: "doc-b" });
    const b = item({ id: "g-b", docId: "doc-b", parentDocId: "doc-a" });
    const fam = buildFamily([a, b], a);
    expect(fam.ancestors.map((x) => x.id).sort()).toEqual(["g-b"]);
  });
});
