import { describe, expect, it } from "vitest";
import { normalizeProject } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

function baseDoc(): ProjectDocument {
  return {
    schemaVersion: 1,
    id: "test",
    name: "Test",
    bpm: 124,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [],
    patterns: [],
    activePatternId: "",
    scenes: [],
    arrangement: { clips: [] },
    markers: [],
    sceneAutomation: [],
    automation: [],
    lfos: [],
    macros: [],
    returns: [],
    master: { masterGain: 1, ceilingDb: -1, limiterEnabled: true, clipperEnabled: false },
    createdAt: "",
    updatedAt: "",
  };
}

describe("master config — gain staging", () => {
  it("clamps masterGain to 0..2 and backs in defaults", () => {
    const dirty = { ...baseDoc(), master: { ...baseDoc().master, masterGain: 9 } } as unknown as ProjectDocument;
    const fixed = normalizeProject(dirty);
    expect(fixed.master.masterGain).toBe(2);
  });
  it("clamps masterGain to 0 on the low end", () => {
    const dirty = { ...baseDoc(), master: { ...baseDoc().master, masterGain: -1 } } as unknown as ProjectDocument;
    const fixed = normalizeProject(dirty);
    expect(fixed.master.masterGain).toBe(0);
  });
  it("clamps ceilingDb to -12..0 (the limiter's safe range)", () => {
    const dirty = { ...baseDoc(), master: { ...baseDoc().master, ceilingDb: 5 } } as unknown as ProjectDocument;
    const fixed = normalizeProject(dirty);
    expect(fixed.master.ceilingDb).toBe(0);
    const dirty2 = { ...baseDoc(), master: { ...baseDoc().master, ceilingDb: -20 } } as unknown as ProjectDocument;
    expect(normalizeProject(dirty2).master.ceilingDb).toBe(-12);
  });
  it("preserves limiterEnabled / clipperEnabled within safe bounds", () => {
    const proj = {
      ...baseDoc(),
      master: { ...baseDoc().master, limiterEnabled: false as boolean, clipperEnabled: true as boolean },
    } as ProjectDocument;
    const fixed = normalizeProject(proj);
    expect(fixed.master.limiterEnabled).toBe(false);
    expect(fixed.master.clipperEnabled).toBe(true);
  });
});
