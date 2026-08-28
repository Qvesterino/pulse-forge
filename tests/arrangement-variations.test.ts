import { describe, expect, it } from "vitest";
import { ArrangementCaptureController } from "../src/arrangement/capture";
import {
  addArrangementTransition,
  arrangementSkeletonPreview,
  createArrangementSkeleton,
  createVariationAndPlaceClip,
  duplicatePatternForScene,
  duplicateSceneAsVariation,
  reorderScenes,
} from "../src/commands/commands";
import { yDocToProject, projectToYDoc } from "../src/collab/YDocAdapter";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { inferSceneRole, normalizeProject } from "../src/project-model/schema";
import { BAR_TICKS } from "../src/project-model/types";
import * as Y from "yjs";
import { ProjectStore } from "../src/store/ProjectStore";

describe("arrangement variations", () => {
  it("creates an independent scene and pattern variation", () => {
    const doc = createProjectFromTemplate("scene-score");
    const store = new ProjectStore(doc);
    const source = store.doc.scenes[2];
    const sourcePattern = store.doc.patterns.find((pattern) => pattern.id === source.patternId)!;

    store.execute(duplicateSceneAsVariation(store.doc, source.id));
    const variation = store.doc.scenes[store.doc.scenes.length - 1];
    const variationPattern = store.doc.patterns.find((pattern) => pattern.id === variation.patternId)!;

    expect(variation.id).not.toBe(source.id);
    expect(variation.patternId).not.toBe(source.patternId);
    expect(variation.name).toMatch(/^DROP VAR/);
    expect(variationPattern.rows).toEqual(sourcePattern.rows);
    expect(variationPattern.rows).not.toBe(sourcePattern.rows);
    expect(variationPattern.notes).not.toBe(sourcePattern.notes);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.scenes).toEqual(doc.scenes);
    expect(store.doc.patterns).toEqual(doc.patterns);
  });

  it("places a variation as one atomic operation without touching the source", () => {
    const doc = createProjectFromTemplate("scene-score");
    const store = new ProjectStore(doc);
    const sourceId = store.doc.scenes[0].id;
    const end = Math.max(...store.doc.arrangement.clips.map((clip) => clip.startBar + clip.lengthBars));

    store.execute(createVariationAndPlaceClip(store.doc, sourceId, end, 1, "fill"));
    expect(store.doc.arrangement.clips.at(-1)?.lengthBars).toBe(1);
    expect(store.doc.scenes.at(-1)?.role).toBe("fill");
    expect(store.undoStackLength).toBe(1);
  });

  it("duplicates a shared pattern for one scene and leaves the other scene linked", () => {
    const doc = createProjectFromTemplate("house");
    const store = new ProjectStore(doc);
    const source = store.doc.scenes[0];
    const sibling = { ...store.doc.scenes[1], patternId: source.patternId };
    store.execute({
      type: "sharePatternForTest",
      label: "Share pattern for test",
      execute: (current) => ({ ...current, scenes: [current.scenes[0], sibling, ...current.scenes.slice(2)] }),
      undo: (current) => current,
    });
    const sharedPatternId = store.doc.scenes[0].patternId;

    store.execute(duplicatePatternForScene(store.doc, source.id));

    expect(store.doc.scenes[0].patternId).not.toBe(sharedPatternId);
    expect(store.doc.scenes[1].patternId).toBe(sharedPatternId);
    expect(store.doc.patterns).toHaveLength(doc.patterns.length + 1);
    expect(store.doc.activePatternId).toBe(store.doc.scenes[0].patternId);
    expect(store.undoStackLength).toBe(2);
  });

  it("reorders scenes and infers roles for older names", () => {
    const doc = createProjectFromTemplate("scene-score");
    const store = new ProjectStore(doc);
    expect(inferSceneRole("BUILD variation")).toBe("build");
    store.execute(reorderScenes(store.doc, 0, 4));
    expect(store.doc.scenes.map((scene) => scene.name)).toEqual(["BUILD", "DROP", "BREAK", "OUTRO", "INTRO"]);
  });

  it("builds the fixed skeleton from existing role/name scenes", () => {
    const doc = createProjectFromTemplate("scene-score");
    const preview = arrangementSkeletonPreview(doc);
    expect(preview.map((step) => [step.role, step.startBar, step.lengthBars])).toEqual([
      ["intro", 0, 8],
      ["build", 8, 8],
      ["drop", 16, 16],
      ["break", 32, 8],
      ["outro", 40, 8],
    ]);

    const store = new ProjectStore(doc);
    store.execute(createArrangementSkeleton(store.doc));
    expect(store.doc.arrangement.clips.map((clip) => clip.lengthBars)).toEqual([8, 8, 16, 8, 8]);
    expect(store.undoStackLength).toBe(1);
  });

  it("adds, updates and removes transitions while preserving clip boundaries", () => {
    const doc = createProjectFromTemplate("scene-score");
    const store = new ProjectStore(doc);
    const [from, to] = store.doc.arrangement.clips;
    store.execute(addArrangementTransition(store.doc, from.id, to.id, "riser", 3, "factory.fx.riser"));
    expect(store.doc.arrangement.transitions?.[0]).toMatchObject({
      type: "riser",
      lengthBars: 3,
      cueAssetId: "factory.fx.riser",
    });
    store.undo();
    expect(store.doc.arrangement.transitions).toBeUndefined();
  });
});

describe("arrangement capture", () => {
  it("quantizes launches, coalesces same-bar launches and appends one undoable take", () => {
    const doc = createProjectFromTemplate("house");
    const store = new ProjectStore(doc);
    let tick = 0;
    const capture = new ArrangementCaptureController(
      () => store.doc,
      (command) => store.execute(command),
      () => tick,
    );
    const scenes = store.doc.scenes;
    capture.start();
    capture.recordSceneLaunch(scenes[0].id, 0);
    capture.recordSceneLaunch(scenes[0].id, BAR_TICKS / 2);
    capture.recordSceneLaunch(scenes[0].id, BAR_TICKS * 2);
    tick = BAR_TICKS * 5;

    expect(capture.finish()).toBe(true);
    expect(store.doc.arrangement.clips.map((clip) => [clip.startBar, clip.lengthBars])).toEqual([
      [0, 4],
      [4, 2],
      [6, 2],
    ]);
    expect(store.undoStackLength).toBe(1);
  });

  it("cancel leaves the project untouched", () => {
    const doc = createProjectFromTemplate("house");
    const store = new ProjectStore(doc);
    const capture = new ArrangementCaptureController(
      () => store.doc,
      (command) => store.execute(command),
      () => BAR_TICKS * 4,
    );
    capture.start();
    capture.recordSceneLaunch(store.doc.scenes[0].id, 0);
    capture.cancel();
    expect(store.doc).toEqual(doc);
    expect(capture.getSnapshot().capturing).toBe(false);
  });
});

describe("arrangement persistence", () => {
  it("round-trips scene roles and transitions through YDoc", () => {
    const doc = createProjectFromTemplate("scene-score");
    const roleDoc = normalizeProject({
      ...doc,
      scenes: doc.scenes.map((scene, index) => (index === 0 ? { ...scene, role: "intro" as const } : scene)),
      arrangement: {
        ...doc.arrangement,
        transitions: [
          {
            id: "transition-test",
            fromClipId: doc.arrangement.clips[0].id,
            toClipId: doc.arrangement.clips[1].id,
            type: "fill",
            lengthBars: 2,
          },
        ],
      },
    });
    const yDoc = new Y.Doc();
    projectToYDoc(roleDoc, yDoc.getMap("project"));
    const restored = yDocToProject(yDoc.getMap("project"));
    expect(restored.scenes[0].role).toBe("intro");
    expect(restored.arrangement.transitions).toEqual(roleDoc.arrangement.transitions);
  });

  it("drops transitions that reference missing clips during normalization", () => {
    const doc = createProjectFromTemplate("house");
    const normalized = normalizeProject({
      ...doc,
      arrangement: {
        ...doc.arrangement,
        transitions: [
          {
            id: "dangling",
            fromClipId: "missing",
            toClipId: doc.arrangement.clips[0].id,
            type: "drop",
            lengthBars: 20,
          },
        ],
      },
    });
    expect(normalized.arrangement.transitions).toEqual([]);
  });
});
