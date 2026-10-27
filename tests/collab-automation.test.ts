import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDefaultProject } from "../src/project-model/schema";
import {
  addAutomationClip,
  linkAutomationClipTarget,
  unlinkAutomationClipTarget,
} from "../src/commands/automationClips";
import { createInstrumentTrack, deleteTrack } from "../src/commands/tracks";
import { arrangementAutomationSegmentsInWindow, automationClipEventsInWindow } from "../src/project-model/events";
import { migrateProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { automationClipForTarget, automationTargetKey, automationTargetsOfClip } from "../src/project-model/targets";
import { applyProjectToYMap, projectToYDoc, yDocToProject } from "../src/collab/YDocAdapter";
import type { ArrangementAutomationClip, AutomationTarget, ProjectDocument } from "../src/project-model/types";

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
    (track as { effects: unknown[] }).effects = [{ id: "fx-ultina-1", type: "ultina", bypassed: false, params: {} }];
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

function projectWithArrangementAutomation(): {
  doc: ProjectDocument;
  gain: AutomationTarget;
  pan: AutomationTarget;
} {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((candidate) => candidate.kind === "instrument");
  if (!track) throw new Error("house template needs an instrument track");
  const gain: AutomationTarget = { kind: "trackGain", trackId: track.id };
  const pan: AutomationTarget = { kind: "trackPan", trackId: track.id };
  const clip: ArrangementAutomationClip = {
    id: "auto-gain",
    target: gain,
    linkedTargets: [pan],
    startTick: 0,
    lengthTicks: 200,
    points: [
      { tick: 0, value: 0 },
      { tick: 200, value: 1.5 },
    ],
  };
  const doc = normalizeProject({
    ...base,
    arrangement: { ...base.arrangement, automationClips: [clip] },
  });
  return { doc, gain, pan };
}

describe("linked arrangement automation targets", () => {
  it("maps the primary curve and resolves overlap independently for each target", () => {
    const { doc, gain, pan } = projectWithArrangementAutomation();
    const primary = doc.arrangement.automationClips![0]!;
    const mapped = automationClipForTarget(doc, primary, pan);
    expect(mapped.points.map((point) => point.value)).toEqual([-1, 1]);
    expect(automationClipForTarget(doc, primary, gain)).toBe(primary);

    const panOverride: ArrangementAutomationClip = {
      id: "pan-override",
      target: pan,
      startTick: 50,
      lengthTicks: 100,
      points: [
        { tick: 0, value: 1 },
        { tick: 100, value: -1 },
      ],
    };
    const segments = arrangementAutomationSegmentsInWindow([primary, panOverride], 0, 200);
    expect(
      segments.map((segment) => [
        automationTargetKey(segment.target),
        segment.clip.id,
        segment.fromTick,
        segment.toTick,
      ]),
    ).toEqual([
      [automationTargetKey(gain), primary.id, 0, 200],
      [automationTargetKey(pan), primary.id, 0, 50],
      [automationTargetKey(pan), panOverride.id, 50, 150],
      [automationTargetKey(pan), primary.id, 150, 200],
    ]);
    expect(automationClipEventsInWindow(mapped, 0, 200).map((point) => point.value)).toEqual([-1, 1]);

    const steppedClip = {
      ...primary,
      points: [
        { tick: 0, value: 0 },
        { tick: 100, value: 1 },
        { tick: 200, value: 1 },
      ],
    };
    expect(automationClipEventsInWindow(steppedClip, 25, 175, 0, true)).toEqual([
      { tick: 25, value: 0 },
      { tick: 100, value: 1 },
      { tick: 175, value: 1 },
    ]);
  });

  it("links and unlinks targets as undoable commands", () => {
    const { doc, gain, pan } = projectWithArrangementAutomation();
    const withoutClip = { ...doc, arrangement: { ...doc.arrangement, automationClips: [] } };
    const added = addAutomationClip(withoutClip, gain, 0, 200, [
      { tick: 0, value: 0 },
      { tick: 200, value: 1.5 },
    ]).execute(withoutClip);
    const clipId = added.arrangement.automationClips![0]!.id;
    const link = linkAutomationClipTarget(added, clipId, pan);
    const linked = link.execute(added);
    expect(linked.arrangement.automationClips![0]!.linkedTargets).toEqual([pan]);
    expect(link.undo(linked)).toEqual(added);

    const unlink = unlinkAutomationClipTarget(linked, clipId, pan);
    const unlinked = unlink.execute(linked);
    expect(unlinked.arrangement.automationClips![0]!.linkedTargets).toBeUndefined();
    expect(unlink.undo(unlinked)).toEqual(linked);
  });

  it("strips a deleted track from linked targets while preserving the clip and undo", () => {
    const { doc, gain } = projectWithArrangementAutomation();
    const withoutClip = { ...doc, arrangement: { ...doc.arrangement, automationClips: [] } };
    const sourceTrack = doc.tracks.find((track) => track.kind === "instrument");
    if (!sourceTrack || sourceTrack.kind !== "instrument") throw new Error("house template needs an instrument track");
    const withSecondTrack = createInstrumentTrack(withoutClip, sourceTrack.instrument).execute(withoutClip);
    const linkedTrack = withSecondTrack.tracks.find(
      (track) => track.id !== sourceTrack.id && track.kind === "instrument",
    );
    if (!linkedTrack || linkedTrack.kind !== "instrument") throw new Error("expected a second instrument track");
    const linkedGain: AutomationTarget = { kind: "trackGain", trackId: linkedTrack.id };
    const added = addAutomationClip(withSecondTrack, gain, 0, 200, [
      { tick: 0, value: 0 },
      { tick: 200, value: 1.5 },
    ]).execute(withSecondTrack);
    const clipId = added.arrangement.automationClips![0]!.id;
    const linked = linkAutomationClipTarget(added, clipId, linkedGain).execute(added);
    const remove = deleteTrack(linked, linkedTrack.id);
    const removed = remove.execute(linked);

    expect(removed.arrangement.automationClips).toHaveLength(1);
    expect(removed.arrangement.automationClips![0]!.linkedTargets).toBeUndefined();
    expect(remove.undo(removed).arrangement.automationClips).toEqual(linked.arrangement.automationClips);
  });

  it("normalizes, migrates and round-trips linked targets through Yjs", () => {
    const { doc, gain, pan } = projectWithArrangementAutomation();
    const clip = doc.arrangement.automationClips![0]!;
    const normalized = normalizeProject({
      ...doc,
      arrangement: {
        ...doc.arrangement,
        automationClips: [
          {
            ...clip,
            linkedTargets: [pan, pan, { kind: "trackPan", trackId: "missing-track" } as AutomationTarget],
          },
        ],
      },
    });
    expect(normalized.arrangement.automationClips![0]!.linkedTargets).toEqual([pan]);
    expect(SCHEMA_VERSION).toBe(39);
    const oldClip = { ...clip };
    delete oldClip.linkedTargets;
    const migrated = migrateProject({
      ...doc,
      schemaVersion: 29,
      arrangement: { ...doc.arrangement, automationClips: [oldClip] },
    });
    expect(migrated.schemaVersion).toBe(39);
    expect(migrated.arrangement.automationClips![0]!.linkedTargets).toBeUndefined();

    const yDoc = new Y.Doc();
    const yMap = yDoc.getMap("project");
    projectToYDoc(normalized, yMap);
    expect(yDocToProject(yMap).arrangement.automationClips![0]!.linkedTargets).toEqual([pan]);
    expect(automationTargetsOfClip(normalized.arrangement.automationClips![0]!)).toEqual([gain, pan]);
  });
});
