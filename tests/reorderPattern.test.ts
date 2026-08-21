import { describe, expect, it } from "vitest";
import { reorderPattern } from "../src/commands/commands";
import { createProjectFromTemplate } from "../src/project-model/templates";

describe("reorderPattern", () => {
  function multiPatternDoc() {
    // scene-score template has 5 patterns: intro, build, drop, break, outro
    return createProjectFromTemplate("scene-score");
  }

  it("moves pattern from index 0 to index 2", () => {
    const doc = multiPatternDoc();
    const ids = doc.patterns.map((p) => p.id);
    const cmd = reorderPattern(doc, 0, 2);
    const next = cmd.execute(doc);
    expect(next.patterns[0].id).toBe(ids[1]);
    expect(next.patterns[1].id).toBe(ids[2]);
    expect(next.patterns[2].id).toBe(ids[0]);
  });

  it("moves pattern from index 4 to index 0", () => {
    const doc = multiPatternDoc();
    const ids = doc.patterns.map((p) => p.id);
    const cmd = reorderPattern(doc, 4, 0);
    const next = cmd.execute(doc);
    expect(next.patterns[0].id).toBe(ids[4]);
    expect(next.patterns[1].id).toBe(ids[0]);
  });

  it("no-op when fromIndex === toIndex", () => {
    const doc = multiPatternDoc();
    const cmd = reorderPattern(doc, 2, 2);
    const next = cmd.execute(doc);
    expect(next.patterns.map((p) => p.id)).toEqual(doc.patterns.map((p) => p.id));
  });

  it("undo restores original order", () => {
    const doc = multiPatternDoc();
    const ids = doc.patterns.map((p) => p.id);
    const cmd = reorderPattern(doc, 0, 3);
    const next = cmd.execute(doc);
    const undone = cmd.undo(next);
    expect(undone.patterns.map((p) => p.id)).toEqual(ids);
  });

  it("throws on out-of-range fromIndex", () => {
    const doc = multiPatternDoc();
    expect(() => reorderPattern(doc, -1, 0)).toThrow();
    expect(() => reorderPattern(doc, 99, 0)).toThrow();
  });

  it("throws on out-of-range toIndex", () => {
    const doc = multiPatternDoc();
    expect(() => reorderPattern(doc, 0, -1)).toThrow();
    expect(() => reorderPattern(doc, 0, 99)).toThrow();
  });

  it("preserves pattern data (names, ids, rows)", () => {
    const doc = multiPatternDoc();
    const cmd = reorderPattern(doc, 1, 3);
    const next = cmd.execute(doc);
    // Moving index 1 → index 3: [intro, build, drop, break, outro] → [intro, drop, break, build, outro]
    expect(next.patterns[3].name).toBe(doc.patterns[1].name);
    expect(next.patterns[3].rows).toBe(doc.patterns[1].rows);
  });
});
