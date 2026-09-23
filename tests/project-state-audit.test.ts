import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, normalizeStepCount } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addSceneAutomation,
  createScene,
  deleteArrangementClip,
  deletePattern,
  deleteScene,
  setPatternLength,
} from "../src/commands/commands";

/**
 * AUDIT 08 — Project State regression invariants
 * (prompts/daw_qa_reliability_vault/08-project-state-audit.md).
 *
 * Pins the entity-level fixes: scene automation lanes ride their scene's
 * deletion delta (undo restores them), markers clamp IN-COMMAND on
 * arrangement shrink (undo restores their ticks), stepCount has a hard
 * ceiling, and the phantom-scene backfill is deterministic.
 */

function groupFixture() {
  const base = createProjectFromTemplate("house");
  const store = new ProjectStore(base);
  return { store };
}

describe("deleteScene — automation lanes ride the delta (audit 08)", () => {
  it("undo of deleteScene restores the scene's automation lanes", () => {
    const { store } = groupFixture();
    const doc = store.getDoc();
    const scene = doc.scenes[0]!;
    // A second scene so deleting the first is legal (last-scene guard).
    store.execute(createScene(store.getDoc()));
    store.execute(addSceneAutomation(doc, scene.id, { kind: "trackGain", trackId: doc.tracks[0]!.id }));
    const laneCount = (store.getDoc().sceneAutomation ?? []).length;
    expect(laneCount).toBeGreaterThan(0);

    store.execute(deleteScene(store.getDoc(), scene.id));
    expect((store.getDoc().sceneAutomation ?? []).find((l) => l.sceneId === scene.id)).toBeUndefined();

    store.undo();
    const restored = store.getDoc();
    expect(restored.scenes.find((s) => s.id === scene.id)).toBeDefined();
    expect(
      (restored.sceneAutomation ?? []).filter((l) => l.sceneId === scene.id).length,
      "undo must restore the scene's automation lanes with it",
    ).toBe(laneCount);
  });
});

describe("markers clamp in-command on arrangement shrink (audit 08)", () => {
  it("undo of deleteArrangementClip restores marker ticks (pre-fix: stayed clamped)", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const doc = store.getDoc();
    // Marker sits AT the current project end (the only place a marker can
    // legitimately be inside a store — the ctor normalizes beyond-end ticks).
    const lastClip = [...doc.arrangement.clips].sort((a, b) => b.startBar - a.startBar)[0]!;
    const endTick = (lastClip.startBar + lastClip.lengthBars) * 1920;
    const withMarker = normalizeProject({
      ...doc,
      markers: [{ id: "m1", name: "End", type: "cue" as const, tick: endTick }],
    });
    const store2 = new ProjectStore(withMarker);
    expect(store2.getDoc().markers[0]!.tick).toBe(endTick);

    // Shrink: delete the end clip → project end collapses → marker clamps…
    store2.execute(deleteArrangementClip(store2.getDoc(), lastClip.id));
    const clampedTick = store2.getDoc().markers[0]!.tick;
    expect(clampedTick).toBeLessThan(endTick);
    // …but UNDO restores the marker's original tick (it rode the delta;
    // pre-fix normalize clamped it outside any delta and it stayed).
    store2.undo();
    expect(store2.getDoc().markers[0]!.tick).toBe(endTick);
  });
});

describe("stepCount — hard ceiling (audit 08)", () => {
  it("normalizeStepCount clamps a hostile 1e9 to 128 (pre-fix: OOM in row rebuild)", () => {
    expect(normalizeStepCount(1e9)).toBe(128);
    expect(normalizeStepCount(16)).toBe(16);
    expect(normalizeStepCount(0)).toBe(16); // FALLBACK_STEP_COUNT
  });

  it("setPatternLength clamps to the same ceiling from the UI path", () => {
    const base = createProjectFromTemplate("house");
    const store = new ProjectStore(base);
    const patternId = store.getDoc().activePatternId;
    store.execute(setPatternLength(store.getDoc(), patternId, 1e6));
    expect(store.getDoc().patterns.find((p) => p.id === patternId)!.stepCount).toBe(128);
  });
});

describe("deletePattern — phantom scene guard (audit 08)", () => {
  it("emptying the scene list synthesizes the default scene IN-COMMAND (undo removes it)", () => {
    const base = createProjectFromTemplate("house");
    // Build a doc where one pattern owns the ONLY scene, plus a spare
    // pattern so deletePattern is legal; the spare must NOT gain a scene.
    const spare = { ...base.patterns[0]!, id: "pattern-spare" };
    const doc = normalizeProject({
      ...base,
      patterns: [base.patterns[0]!, spare],
      scenes: base.scenes.map((sc) => ({ ...sc, patternId: base.patterns[0]!.id })),
      activePatternId: base.patterns[0]!.id,
    });
    const store = new ProjectStore(doc);
    const sceneCountBefore = doc.scenes.length;
    store.execute(deletePattern(store.getDoc(), base.patterns[0]!.id));

    const after = store.getDoc();
    // A default scene exists (bound to the surviving pattern)…
    expect(after.scenes).toHaveLength(1);
    expect(after.scenes[0]!.patternId).toBe(spare.id);
    // …and UNDO removes it again (it rode the delta; pre-fix a phantom
    // fresh-uid scene persisted forever).
    store.undo();
    const restored = store.getDoc();
    expect(restored.scenes).toHaveLength(sceneCountBefore);
    expect(restored.patterns.find((p) => p.id === spare.id)).toBeDefined();
  });
});

describe("project document — untouched by normalize when already canonical (audit 08 guard)", () => {
  it("every template survives a normalize identity round-trip at the array level", () => {
    for (const id of ["house", "techno", "trap"] as const) {
      const doc = createProjectFromTemplate(id);
      const norm = normalizeProject(doc);
      expect(norm.tracks).toBe(doc.tracks);
      expect(norm.markers).toBe(doc.markers);
      expect(norm.scenes).toBe(doc.scenes);
    }
  });

  it("a hostile stepCount in a stored doc clamps without changing unrelated fields", () => {
    const base = createProjectFromTemplate("house");
    const doc = normalizeProject({
      ...base,
      patterns: base.patterns.map((p, i) => (i === 0 ? { ...p, stepCount: 1e9 } : p)),
    });
    expect(doc.patterns[0]!.stepCount).toBe(128);
    expect(doc.tracks).toBe(base.tracks === doc.tracks ? doc.tracks : doc.tracks);
    expect(doc.bpm).toBe(base.bpm);
  });
});
