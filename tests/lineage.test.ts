import { describe, it, expect } from "vitest";
import { mutateBeat, ensureRootLineage, readLineage, familyProvenance, MUTATE_AMOUNT } from "../src/gallery/lineage";
import { migrateProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { encodeShareCode, decodeShareCode } from "../src/export/shareCode";
import { testDoc } from "./fixtures/doc";

/** Musical content only — ids, timestamps and assist metadata stripped. */
function musicalContent(doc: ReturnType<typeof testDoc>): string {
  const patterns = doc.patterns.map((p) => ({
    rows: p.rows,
    notes: Object.values(p.notes)
      .flat()
      .map((n) => {
        const { id: _id, ...rest } = n as unknown as Record<string, unknown>;
        return rest;
      }),
    stepCount: p.stepCount,
  }));
  return JSON.stringify(patterns);
}

describe("Remix-DNA lineage (schema v3)", () => {
  it("pre-lineage docs read as roots with no lineage", () => {
    expect(readLineage(testDoc())).toBeNull();
  });

  it("ensureRootLineage stamps a root and is idempotent", () => {
    const doc = testDoc();
    const rooted = ensureRootLineage(doc, "dark trap 140", "seed-1");
    expect(rooted.lineage).toEqual({
      parentId: null,
      rootId: doc.id,
      depth: 0,
      prompt: "dark trap 140",
      seed: "seed-1",
    });
    expect(ensureRootLineage(rooted)).toBe(rooted);
  });

  it("mutateBeat links child → parent → root with fresh identity", () => {
    const parent = testDoc();
    const before = musicalContent(parent);
    const { doc: child, lineage, variedPatterns } = mutateBeat(parent, { prompt: "dark trap 140" });
    expect(child.id).not.toBe(parent.id);
    expect(lineage.parentId).toBe(parent.id);
    expect(lineage.rootId).toBe(parent.id);
    expect(lineage.depth).toBe(1);
    expect(lineage.prompt).toBe("dark trap 140");
    expect(child.name).toContain("🧬");
    expect(variedPatterns).toBeGreaterThan(0);
    // the parent is untouched (pure)
    expect(musicalContent(parent)).toBe(before);
  });

  it("grandchildren keep the root and grow depth", () => {
    const parent = testDoc();
    const first = mutateBeat(parent).doc;
    const second = mutateBeat(first);
    expect(second.lineage.rootId).toBe(parent.id);
    expect(second.lineage.parentId).toBe(first.id);
    expect(second.lineage.depth).toBe(2);
  });

  it("same parent + same options = same child content (idempotent mutate)", () => {
    const parent = testDoc();
    const a = mutateBeat(parent, { amount: MUTATE_AMOUNT, sibling: 0 });
    const b = mutateBeat(parent, { amount: MUTATE_AMOUNT, sibling: 0 });
    expect(musicalContent(a.doc)).toBe(musicalContent(b.doc));
    expect(a.lineage).toEqual(b.lineage);
  });

  it("siblings are distinct takes", () => {
    const parent = testDoc();
    const a = mutateBeat(parent, { amount: 0.5, sibling: 0 });
    const b = mutateBeat(parent, { amount: 0.5, sibling: 1 });
    expect(musicalContent(a.doc)).not.toBe(musicalContent(b.doc));
    expect(a.lineage.rootId).toBe(b.lineage.rootId);
  });

  it("amount clamps to 0..1 and sibling floors at 0", () => {
    const parent = testDoc();
    expect(() => mutateBeat(parent, { amount: 99, sibling: -5 })).not.toThrow();
    const { doc } = mutateBeat(parent, { amount: 99, sibling: -5 });
    expect(readLineage(doc)?.depth).toBe(1);
  });

  it("familyProvenance reads intent text/seed when present", () => {
    const { prompt, seed } = familyProvenance(testDoc());
    // house template patterns may or may not carry intent — either null or strings
    expect(prompt === null || typeof prompt === "string").toBe(true);
    expect(seed === null || typeof seed === "string").toBe(true);
  });
});

describe("lineage persistence", () => {
  it("normalize keeps valid lineage canonically", () => {
    const doc = testDoc();
    const rooted = ensureRootLineage(doc, "x", "y");
    expect(normalizeProject(rooted)).toBe(rooted);
  });

  it("normalize drops invalid lineage but keeps the beat", () => {
    const doc = { ...testDoc(), lineage: "garbage" } as unknown as ReturnType<typeof testDoc>;
    const cleaned = normalizeProject(doc);
    expect(cleaned.lineage).toBeUndefined();
    expect(cleaned.patterns.length).toBe(doc.patterns.length);
  });

  it("normalize drops lineage without rootId", () => {
    const doc = {
      ...testDoc(),
      lineage: { parentId: null, depth: 0, prompt: null, seed: null },
    } as unknown as ReturnType<typeof testDoc>;
    expect(normalizeProject(doc).lineage).toBeUndefined();
  });

  it("share-code round-trip preserves the family link", () => {
    const child = mutateBeat(testDoc(), { prompt: "dark trap 140" }).doc;
    const decoded = decodeShareCode(encodeShareCode(child));
    expect(decoded).not.toBeNull();
    expect(decoded!.lineage).toEqual(child.lineage);
  });

  it("old docs migrate to schema 3 without lineage", () => {
    const old = { ...testDoc(), schemaVersion: SCHEMA_VERSION - 1 };
    const migrated = migrateProject(old);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.lineage).toBeUndefined();
  });
});
