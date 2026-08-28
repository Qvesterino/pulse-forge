/**
 * Project invariants — the three load-bearing properties called out in the
 * hardening review. Each `describe` is the PIN for one invariant: if a future
 * feature breaks it, this file must fail loudly BEFORE the scheduler or the
 * persistence layer does.
 *
 * 1. `getActivePattern` never throws on a normalized doc.
 * 2. `testDoc()` is canonical — `normalizeProject(testDoc()) === testDoc`.
 * 3. `placeClipAt` never throws "Clip overlaps" regardless of bar.
 *
 * Rules for contributors:
 *   - Any new command/adapter/import that can produce a dangling
 *     `activePatternId` or a stale scene/clip reference must add a case to
 *     section 1.
 *   - Perf assertions are smoke ceilings (500 ms / 250 ms), NOT tight
 *     budgets. The deterministic invariant (zero Y.Doc writes on a warm
 *     apply) is the real guard — see `collab-hardening.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { getActivePattern } from "../src/project-model/types";
import {
  addArrangementClip,
  createPattern,
  deletePattern,
  renamePattern,
  setActivePattern,
  setBpm,
} from "../src/commands/commands";
import { YDocStore } from "../src/collab/YDocStore";
import {
  activePatternOf,
  commandHarness,
  deterministicTestDoc,
  drumTrackOf,
  placeClipAt,
  testDoc,
} from "./fixtures/doc";

// ─── 1. getActivePattern invariant ─────────────────────────────────────────

describe("invariant — getActivePattern", () => {
  it("throws on a dangling activePatternId (documents the contract)", () => {
    const doc = testDoc();
    const dangling = { ...doc, activePatternId: "ghost-pattern" };
    expect(() => getActivePattern(dangling)).toThrow(/Active pattern ghost-pattern not found/);
  });

  it("never throws after normalizeProject", () => {
    const doc = testDoc();
    const dangling = { ...doc, activePatternId: "ghost-pattern" };
    const normalized = normalizeProject(dangling);
    expect(() => getActivePattern(normalized)).not.toThrow();
    expect(normalized.activePatternId).toBe(normalized.patterns[0].id);
  });

  it("YDocStore repairs a dangling activePatternId injected by a foreign peer", () => {
    const store = YDocStore.fromDocument(testDoc());
    store.yDocRef.transact(() => {
      store.yDocRef.getMap("project").set("activePatternId", "ghost-pattern");
    });
    expect(() => getActivePattern(store.doc)).not.toThrow();
    expect(store.doc.activePatternId).toBe(store.doc.patterns[0].id);
  });

  it("deletePattern never leaves a dangling activePatternId", () => {
    const h = commandHarness();
    const victimId = h.doc.patterns[0].id;
    // Ensure at least two patterns so deletion is legal.
    if (h.doc.patterns.length < 2) {
      h.run(createPattern(h.doc, "Extra"));
    }
    const cmd = deletePattern(h.doc, victimId);
    const result = cmd.execute(h.doc);
    expect(() => getActivePattern(result)).not.toThrow();
  });

  it("setActivePattern ignores a non-existent id (no dangling write)", () => {
    const doc = testDoc();
    const cmd = setActivePattern(doc, "ghost-pattern");
    const result = cmd.execute(doc);
    expect(result.activePatternId).toBe(doc.activePatternId);
    expect(() => getActivePattern(result)).not.toThrow();
  });
});

// ─── 2. testDoc canonical invariant ────────────────────────────────────────

describe("invariant — testDoc canonical", () => {
  it("testDoc() is already normalized (reference identity)", () => {
    const doc = testDoc();
    expect(normalizeProject(doc)).toBe(doc);
  });

  it("deterministicTestDoc() is also canonical and cross-instance ids align", () => {
    const a = deterministicTestDoc();
    const b = deterministicTestDoc();
    expect(normalizeProject(a)).toBe(a);
    expect(a.patterns[0].id).toBe(b.patterns[0].id);
    expect(drumTrackOf(a).id).toBe(drumTrackOf(b).id);
  });
});

// ─── 3. placeClipAt / empty-arrangement invariant ──────────────────────────

describe("invariant — arrangement clips", () => {
  it("testDoc has an empty arrangement", () => {
    expect(testDoc().arrangement.clips).toHaveLength(0);
  });

  it("placeClipAt never throws overlap regardless of requested bar", () => {
    let doc = testDoc();
    // Fill bars 0..4 with a clip, then ask for bar 0 again — must hop past it.
    doc = placeClipAt(doc, doc.scenes[0].id, 0, 4);
    expect(doc.arrangement.clips).toHaveLength(1);
    doc = placeClipAt(doc, doc.scenes[0].id, 0, 2);
    expect(doc.arrangement.clips).toHaveLength(2);
    expect(doc.arrangement.clips[1].startBar).toBeGreaterThanOrEqual(4);
  });

  it("raw addArrangementClip at bar 0 on house DOES throw (documents the trap)", () => {
    // house template ships with a clip at bar 0; any new clip there must overlap.
    const houseDoc = createProjectFromTemplate("house");
    expect(houseDoc.arrangement.clips.length).toBeGreaterThan(0);
    expect(() => addArrangementClip(houseDoc, houseDoc.scenes[0].id, 0, 2).execute(houseDoc)).toThrow(/overlaps/);
  });
});

// ─── Fixture helpers — commandHarness + accessors ──────────────────────────

describe("fixtures — commandHarness & accessors", () => {
  it("harness keeps build-from and execute-on the same doc", () => {
    const h = commandHarness();
    h.run(setBpm(h.doc, 140));
    h.run(renamePattern(h.doc, h.doc.patterns[0].id, "Harness"));
    expect(h.doc.bpm).toBe(140);
    expect(activePatternOf(h.doc).name).toBe("Harness");
    h.undo();
    expect(activePatternOf(h.doc).name).not.toBe("Harness");
  });

  it("accessors throw with context instead of leaking undefined", () => {
    const empty: any = { tracks: [], patterns: [], scenes: [], arrangement: { clips: [] } };
    expect(() => drumTrackOf(empty as any)).toThrow(/drum track/);
    expect(() => activePatternOf(empty as any)).toThrow(/activePatternId/);
  });
});
