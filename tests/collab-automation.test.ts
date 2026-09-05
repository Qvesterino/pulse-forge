import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDefaultProject } from "../src/project-model/schema";
import { applyProjectToYMap, projectToYDoc, yDocToProject } from "../src/collab/YDocAdapter";
import type { ProjectDocument } from "../src/project-model/types";

function docWithAutomation(): ProjectDocument {
  const doc = createDefaultProject();
  const trackId = doc.tracks[0].id;
  const sceneId = doc.scenes[0].id;
  doc.tags = ["techno", "wip", "128"];
  doc.automation = [
    {
      id: "lane-1",
      target: { kind: "trackGain", trackId },
      points: [
        { tick: 0, value: 0 },
        { tick: 240, value: 0.5 },
        { tick: 480, value: 1 },
      ],
    },
  ];
  doc.sceneAutomation = [
    {
      id: "sa-1",
      sceneId,
      target: { kind: "trackPan", trackId },
      points: [
        { tick: 0, value: 1 },
        { tick: 960, value: 0 },
      ],
    },
  ];
  return doc;
}

describe("YDocAdapter — automation and tags round-trip", () => {
  it("preserves automation/scene automation points (incl. value 0) via projectToYDoc", () => {
    const doc = docWithAutomation();
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    // Regression: points used to deserialize as {tick: undefined, value: undefined}
    // because Y.Map fields were read as plain properties.
    expect(restored.automation).toEqual(doc.automation);
    expect(restored.sceneAutomation).toEqual(doc.sceneAutomation);
  });

  it("preserves tags via projectToYDoc", () => {
    const doc = docWithAutomation();
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    expect(restored.tags).toEqual(["techno", "wip", "128"]);
  });

  it("preserves automation points and tags via applyProjectToYMap", () => {
    const doc = docWithAutomation();
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    applyProjectToYMap(doc, doc, yMap);
    const restored = yDocToProject(yMap);
    expect(restored.automation).toEqual(doc.automation);
    expect(restored.sceneAutomation).toEqual(doc.sceneAutomation);
    expect(restored.tags).toEqual(["techno", "wip", "128"]);
  });

  it("empty tags round-trip to an empty array, not undefined", () => {
    const doc = createDefaultProject();
    doc.tags = [];
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    expect(restored.tags).toEqual([]);
  });

  it("preserves deep-parameter fxParam lanes (Ultina) via projectToYDoc", () => {
    // The deep automation surface (phase U1) writes lane targets with dotted
    // param ids like "eq.band3.gainDb" — the collab layer must treat them as
    // opaque strings, never re-validate against the registry rack list.
    const doc = docWithAutomation();
    const track = doc.tracks.find((t) => t.effects !== undefined) ?? doc.tracks[0];
    (track as { effects: unknown[] }).effects = [
      { id: "fx-ultina-1", type: "ultina", bypassed: false, params: {} },
    ];
    doc.automation.push({
      id: "lane-ultina-deep",
      target: { kind: "fxParam", trackId: track.id, fxId: "fx-ultina-1", paramId: "eq.band3.gainDb" },
      points: [
        { tick: 0, value: -6 },
        { tick: 480, value: 3.5 },
      ],
    });
    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(doc, yMap);
    const restored = yDocToProject(yMap);
    const lane = restored.automation.find((l) => l.id === "lane-ultina-deep");
    expect(lane).toBeDefined();
    expect(lane!.target).toMatchObject({
      kind: "fxParam",
      fxId: "fx-ultina-1",
      paramId: "eq.band3.gainDb",
    });
    expect(lane!.points).toEqual([
      { tick: 0, value: -6 },
      { tick: 480, value: 3.5 },
    ]);
  });
});
