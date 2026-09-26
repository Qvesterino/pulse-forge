import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { applyMixIntent, planMixProfile } from "../src/intent/mix";
import type { ProjectDocument, Scene } from "../src/project-model/types";

/**
 * QA-3 PER-SECTION MIX — pump instances installed by a mix profile follow
 * scene intensity (drops pump harder, breaks breathe) via sceneAutomation
 * lanes, in the same undo step. Static params stay the profile values;
 * lanes scale them: amount × (0.7 + 0.6 × intensity), neutral at 0.5.
 */

function docWithScenes(): ProjectDocument {
  const doc = testDoc();
  const patternId = doc.patterns[0]?.id ?? "pattern-x";
  const scenes: Scene[] = [
    { id: "scene-intro", name: "Intro", patternId, intensity: 0.4, role: "intro" },
    { id: "scene-drop", name: "Drop A", patternId, intensity: 0.9, role: "drop" },
    { id: "scene-break", name: "Break", patternId, intensity: 0.35, role: "break" },
  ];
  return { ...doc, scenes };
}

const PUMP_INTENT = normalizeIntent({ genre: "house", seed: "scene-ride", energy: 0.8 });

function pumpLanes(doc: ProjectDocument) {
  return doc.sceneAutomation.filter((lane) => lane.target.kind === "fxParam" && lane.target.paramId === "amount");
}

describe("per-section pump ride (applyMixIntent scene lanes)", () => {
  it("writes one amount lane per pump track per scene, scaled by intensity", () => {
    const doc = docWithScenes();
    const profile = planMixProfile(PUMP_INTENT);
    expect(profile.decisions.some((d) => d.effectType === "pump")).toBe(true);
    const next = applyMixIntent(doc, profile).execute(doc);

    const pumps = next.tracks.flatMap((t) =>
      t.kind === "instrument" ? t.effects.filter((fx) => fx.type === "pump").map((fx) => ({ trackId: t.id, fx })) : [],
    );
    expect(pumps.length).toBeGreaterThanOrEqual(1);
    const lanes = pumpLanes(next);
    expect(lanes.length).toBe(pumps.length * 3);

    for (const { trackId, fx } of pumps) {
      const base = fx.params.amount as number;
      for (const [sceneId, intensity, factor] of [
        ["scene-intro", 0.4, 0.94],
        ["scene-drop", 0.9, 1.24],
        ["scene-break", 0.35, 0.91],
      ] as const) {
        expect(factor).toBeCloseTo(0.7 + 0.6 * intensity, 6); // the ride formula itself
        const lane = lanes.find((l) => l.sceneId === sceneId && l.target.kind === "fxParam" && l.target.fxId === fx.id);
        expect(lane, `${trackId}/${sceneId}`).toBeDefined();
        expect(lane!.points).toEqual([{ tick: 0, value: Math.round(base * factor * 1000) / 1000 }]);
        expect(lane!.id).toBe(`sceneAuto-${fx.id}-amount-${sceneId}`);
      }
    }
  });

  it("stays idempotent — a second identical apply throws 'changed nothing'", () => {
    const doc = docWithScenes();
    const profile = planMixProfile(PUMP_INTENT);
    const once = applyMixIntent(doc, profile).execute(doc);
    expect(() => applyMixIntent(once, profile)).toThrow(/changed nothing/);
  });

  it("writes no lanes without scenes (legacy behavior)", () => {
    const doc = { ...testDoc(), scenes: [] };
    const next = applyMixIntent(doc, planMixProfile(PUMP_INTENT)).execute(doc);
    expect(pumpLanes(next)).toHaveLength(0);
  });

  it("one undo restores tracks and lanes together", () => {
    const doc = docWithScenes();
    const before = JSON.stringify({ tracks: doc.tracks, lanes: doc.sceneAutomation });
    const cmd = applyMixIntent(doc, planMixProfile(PUMP_INTENT));
    const next = cmd.execute(doc);
    expect(pumpLanes(next).length).toBeGreaterThan(0);
    const undone = cmd.undo(next);
    expect(JSON.stringify({ tracks: undone.tracks, lanes: undone.sceneAutomation })).toBe(before);
  });

  it("is deterministic across fresh applies (ids differ, musical content does not)", () => {
    const profile = planMixProfile(PUMP_INTENT);
    const shape = (doc: ProjectDocument) =>
      pumpLanes(doc).map((lane) => ({ scene: lane.sceneId, points: lane.points }));
    const a = applyMixIntent(docWithScenes(), profile).execute(docWithScenes());
    const b = applyMixIntent(docWithScenes(), profile).execute(docWithScenes());
    expect(shape(a)).toEqual(shape(b));
  });
});
