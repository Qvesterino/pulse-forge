import { describe, expect, it } from "vitest";
import { BAR_TICKS } from "../../src/project-model/types";
import { createDefaultProject } from "../../src/project-model/schema";
import { buildSceneIntensityPoints, type ClipWindow } from "../../src/rendering/renderer";

describe("offline scene intensity timeline", () => {
  it("expands the same scene curve at clip boundaries and returns to neutral in the tail", () => {
    const base = createDefaultProject();
    const scene = {
      ...base.scenes[0],
      intensity: 0.2,
      intensityCurve: [
        { offset: 0, value: 0.2 },
        { offset: BAR_TICKS / 2, value: 0.8 },
        { offset: BAR_TICKS, value: 0.4 },
      ],
    };
    const doc = { ...base, scenes: [scene] };
    const window: ClipWindow = {
      pattern: base.patterns[0],
      base: 0,
      from: 0,
      to: BAR_TICKS,
      bpm: base.bpm,
      sceneId: scene.id,
    };

    expect(buildSceneIntensityPoints(doc, [window], BAR_TICKS)).toEqual([
      { tick: 0, value: 0.2 },
      { tick: BAR_TICKS / 2, value: 0.8 },
      { tick: BAR_TICKS, value: 0.7 },
    ]);
  });
});
