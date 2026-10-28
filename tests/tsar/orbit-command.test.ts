import { describe, expect, it } from "vitest";
import {
  applyOrbitPreset,
  clearOrbitRecording,
  orbitMappingOf,
  recordOrbitPath,
  restoreDefaultOrbitMapping,
  setOrbitMapping,
  setOrbitPosition,
} from "../../src/commands/tsarOrbit";
import { setAutomationPointAt } from "../../src/commands/automation";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { normalizeProject } from "../../src/project-model/schema";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";
import { defaultOrbitMapping, ORBIT_PRESETS } from "../../src/tsar/orbit";

/**
 * TSAR ORBIT — the commands (ADR 0074).
 *
 * The surface's promise is a project-level promise: the mapping travels
 * with the patch, a movement is ONE undoable step, a recording lands in the
 * ordinary project automation (one point per tick), and the original
 * mapping comes back with one command.
 */

function tsarDoc(): { doc: ProjectDocument; trackId: string } {
  const doc = createProjectFromTemplate("house");
  const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
  if (!base) throw new Error("house template has no instrument track");
  const track: InstrumentTrack = {
    ...base,
    id: "tsar-orbit-test",
    instrument: "tsar",
    params: { ...defaultInstrumentParams("tsar") },
  };
  doc.tracks.push(track);
  return { doc, trackId: track.id };
}

function trackOf(doc: ProjectDocument, trackId: string): InstrumentTrack {
  const track = doc.tracks.find((candidate): candidate is InstrumentTrack => candidate.id === trackId);
  if (!track) throw new Error("track missing");
  return track;
}

describe("ORBIT mapping commands", () => {
  it("installs a mapping on the track", () => {
    const { doc, trackId } = tsarDoc();
    const mapping = { x: { paramId: "srcACutoff", min: 200, max: 12000 }, y: { paramId: "morph", min: 0, max: 1 } };
    const next = setOrbitMapping(doc, trackId, mapping).execute(doc);
    expect(trackOf(next, trackId).orbit).toEqual(mapping);
  });

  it("refuses two axes on the same parameter — the surface would have nothing to say", () => {
    const { doc, trackId } = tsarDoc();
    const collide = {
      x: { paramId: "srcACutoff", min: 30, max: 18000 },
      y: { paramId: "srcACutoff", min: 30, max: 18000 },
    };
    expect(() => setOrbitMapping(doc, trackId, collide)).toThrow(/same parameter/u);
  });

  it("a damaged mapping is repaired before it is stored", () => {
    const { doc, trackId } = tsarDoc();
    const next = setOrbitMapping(doc, trackId, {
      x: { paramId: "notAParam", min: 0, max: 1 },
      y: { paramId: "srcAEngine", min: 0, max: 2 },
    }).execute(doc);
    expect(trackOf(next, trackId).orbit).toEqual(defaultOrbitMapping());
  });

  it("a preset installs its two axes", () => {
    const { doc, trackId } = tsarDoc();
    const preset = ORBIT_PRESETS[1]!;
    const next = applyOrbitPreset(doc, trackId, preset.id).execute(doc);
    expect(trackOf(next, trackId).orbit).toEqual({ x: preset.x, y: preset.y });
  });

  it("an unknown preset is refused", () => {
    const { doc, trackId } = tsarDoc();
    expect(() => applyOrbitPreset(doc, trackId, "nope")).toThrow(/Unknown ORBIT preset/u);
  });

  it("RESTORE puts the original mapping back — one command, no dialog", () => {
    const { doc, trackId } = tsarDoc();
    const changed = applyOrbitPreset(doc, trackId, ORBIT_PRESETS[2]!.id).execute(doc);
    expect(orbitMappingOf(changed, trackId)).not.toEqual(defaultOrbitMapping());
    const restored = restoreDefaultOrbitMapping(changed, trackId).execute(changed);
    expect(orbitMappingOf(restored, trackId)).toEqual(defaultOrbitMapping());
  });

  it("RESTORE is one undoable step", () => {
    const { doc, trackId } = tsarDoc();
    const changed = applyOrbitPreset(doc, trackId, ORBIT_PRESETS[2]!.id).execute(doc);
    const command = restoreDefaultOrbitMapping(changed, trackId);
    const undone = command.undo(command.execute(changed));
    expect(orbitMappingOf(undone, trackId)).toEqual(orbitMappingOf(changed, trackId));
  });

  it("the mapping survives a save / load round trip", () => {
    const { doc, trackId } = tsarDoc();
    const changed = applyOrbitPreset(doc, trackId, ORBIT_PRESETS[1]!.id).execute(doc);
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(changed)) as ProjectDocument);
    expect(orbitMappingOf(reloaded, trackId)).toEqual(orbitMappingOf(changed, trackId));
  });

  it("a track without a mapping reads as the documented default", () => {
    const { doc, trackId } = tsarDoc();
    expect(orbitMappingOf(doc, trackId)).toEqual(defaultOrbitMapping());
  });
});

describe("the project model checks the mapping's SHAPE, not the ORBIT catalogue", () => {
  it("a well-formed mapping survives the normaliser untouched", () => {
    const { doc, trackId } = tsarDoc();
    const changed = applyOrbitPreset(doc, trackId, ORBIT_PRESETS[1]!.id).execute(doc);
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(changed)) as ProjectDocument);
    expect(trackOf(reloaded, trackId).orbit).toEqual(trackOf(changed, trackId).orbit);
  });

  it("a malformed mapping is DROPPED — absent = no ORBIT surface", () => {
    const { doc, trackId } = tsarDoc();
    const broken = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === trackId ? ({ ...t, orbit: { x: 7 } } as unknown as typeof t) : t,
      ),
    };
    const normalized = normalizeProject(broken);
    expect(trackOf(normalized, trackId).orbit).toBeUndefined();
  });

  it("a mapping that names an unknown target survives the normaliser (the catalogue decides at the use boundary)", () => {
    const { doc, trackId } = tsarDoc();
    const stored = { x: { paramId: "notAParam", min: 0, max: 1 }, y: { paramId: "morph", min: 0, max: 1 } };
    const withMapping = { ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, orbit: stored } : t)) };
    const normalized = normalizeProject(withMapping);
    expect(trackOf(normalized, trackId).orbit).toEqual(stored);
    // ...and the USE boundary repairs it: the surface falls back to the
    // default axis instead of driving a parameter that does not exist.
    expect(orbitMappingOf(normalized, trackId).x).toEqual(defaultOrbitMapping().x);
  });
});

describe("ORBIT movement", () => {
  it("writes BOTH axes in ONE command", () => {
    const { doc, trackId } = tsarDoc();
    const mapped = setOrbitMapping(doc, trackId, {
      x: { paramId: "srcACutoff", min: 200, max: 12000 },
      y: { paramId: "morph", min: 0, max: 1 },
    }).execute(doc);
    const next = setOrbitPosition(mapped, trackId, 0.5, 0.25).execute(mapped);
    const track = trackOf(next, trackId);
    expect(track.params.srcACutoff).toBeGreaterThan(200);
    expect(track.params.srcACutoff).toBeLessThan(12000);
    expect(track.params.morph).toBeCloseTo(0.25, 6);
  });

  it("the movement never leaves the axis' own range", () => {
    const { doc, trackId } = tsarDoc();
    const mapped = setOrbitMapping(doc, trackId, {
      x: { paramId: "srcACutoff", min: 200, max: 12000 },
      y: { paramId: "morph", min: 0, max: 1 },
    }).execute(doc);
    const next = setOrbitPosition(mapped, trackId, 5, -3).execute(mapped);
    const track = trackOf(next, trackId);
    expect(track.params.srcACutoff).toBeLessThanOrEqual(12000);
    expect(track.params.morph).toBeGreaterThanOrEqual(0);
  });

  it("a movement is undoable", () => {
    const { doc, trackId } = tsarDoc();
    const before = { ...trackOf(doc, trackId).params };
    const command = setOrbitPosition(doc, trackId, 0.5, 0.5);
    const undone = command.undo(command.execute(doc));
    expect(trackOf(undone, trackId).params).toEqual(before);
  });
});

describe("ORBIT recording", () => {
  it("records the movement into the project automation — one lane per axis", () => {
    const { doc, trackId } = tsarDoc();
    const next = recordOrbitPath(doc, trackId, [
      { tick: 0, x: 0, y: 0 },
      { tick: 480, x: 1, y: 1 },
    ]).execute(doc);
    const lanes = next.automation.filter((lane) => lane.target.kind === "instParam" && lane.target.trackId === trackId);
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) {
      expect(lane.points).toHaveLength(2);
      expect(lane.points.map((point) => point.tick)).toEqual([0, 480]);
    }
  });

  it("the recorded values are the AXIS values, not the raw positions", () => {
    const { doc, trackId } = tsarDoc();
    const mapped = setOrbitMapping(doc, trackId, {
      x: { paramId: "srcACutoff", min: 200, max: 12000 },
      y: { paramId: "morph", min: 0, max: 1 },
    }).execute(doc);
    const next = recordOrbitPath(mapped, trackId, [{ tick: 0, x: 0, y: 0 }]).execute(mapped);
    const cutoffLane = next.automation.find((lane) => lane.target.paramId === "srcACutoff")!;
    const morphLane = next.automation.find((lane) => lane.target.paramId === "morph")!;
    expect(cutoffLane.points[0]!.value).toBeCloseTo(200, 6);
    expect(morphLane.points[0]!.value).toBeCloseTo(0, 6);
  });

  it("one point per tick — a re-recorded tick REPLACES the point, it does not stack", () => {
    const { doc, trackId } = tsarDoc();
    const next = recordOrbitPath(doc, trackId, [
      { tick: 0, x: 0.1, y: 0.1 },
      { tick: 0, x: 0.9, y: 0.9 },
    ]).execute(doc);
    const lanes = next.automation.filter((lane) => lane.target.trackId === trackId);
    for (const lane of lanes) {
      expect(lane.points).toHaveLength(1);
      expect(lane.points[0]!.tick).toBe(0);
    }
    const morphLane = lanes.find((lane) => lane.target.paramId === "morph")!;
    expect(morphLane.points[0]!.value).toBeCloseTo(0.9, 6);
  });

  it("the recording is ONE undoable step", () => {
    const { doc, trackId } = tsarDoc();
    const command = recordOrbitPath(doc, trackId, [
      { tick: 0, x: 0, y: 0 },
      { tick: 480, x: 1, y: 1 },
    ]);
    const undone = command.undo(command.execute(doc));
    expect(undone.automation.filter((lane) => lane.target.trackId === trackId)).toHaveLength(0);
  });

  it("recording into an existing lane updates it instead of making a second one", () => {
    const { doc, trackId } = tsarDoc();
    const first = recordOrbitPath(doc, trackId, [{ tick: 0, x: 0, y: 0 }]).execute(doc);
    const second = recordOrbitPath(first, trackId, [{ tick: 960, x: 1, y: 1 }]).execute(first);
    const lanes = second.automation.filter((lane) => lane.target.trackId === trackId);
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) expect(lane.points.map((point) => point.tick)).toEqual([0, 960]);
  });

  it("an empty recording is refused — a button that does nothing says so", () => {
    const { doc, trackId } = tsarDoc();
    expect(() => recordOrbitPath(doc, trackId, [])).toThrow(/did not move/u);
  });

  it("CLEAR removes the recorded lanes", () => {
    const { doc, trackId } = tsarDoc();
    const recorded = recordOrbitPath(doc, trackId, [{ tick: 0, x: 0, y: 0 }]).execute(doc);
    const cleared = clearOrbitRecording(recorded, trackId).execute(recorded);
    expect(cleared.automation.filter((lane) => lane.target.trackId === trackId)).toHaveLength(0);
  });

  it("the recorded curve is an ordinary lane — the existing KYX workflow can edit it", () => {
    const { doc, trackId } = tsarDoc();
    const next = recordOrbitPath(doc, trackId, [
      { tick: 0, x: 0, y: 0 },
      { tick: 480, x: 1, y: 1 },
    ]).execute(doc);
    const lane = next.automation.find((candidate) => candidate.target.trackId === trackId)!;
    // An ordinary lane: a target the engine understands, and points that the
    // lane editor can move.
    expect(lane.target.kind).toBe("instParam");
    expect(lane.target.paramId).toBeTruthy();
    expect(lane.points.every((point) => typeof point.tick === "number")).toBe(true);
  });
});

describe("the automation upsert a recording needs", () => {
  it("writes a value at a tick, replacing the point that was there", () => {
    const { doc, trackId } = tsarDoc();
    const recorded = recordOrbitPath(doc, trackId, [{ tick: 0, x: 0, y: 0 }]).execute(doc);
    const lane = recorded.automation.find((candidate) => candidate.target.trackId === trackId)!;
    const updated = setAutomationPointAt(recorded, lane.id, 0, 0.75).execute(recorded);
    const laneAfter = updated.automation.find((candidate) => candidate.id === lane.id)!;
    expect(laneAfter.points).toHaveLength(1);
    expect(laneAfter.points[0]!.value).toBeCloseTo(0.75, 6);
  });

  it("keeps the point's identity when it is overwritten", () => {
    const { doc, trackId } = tsarDoc();
    const recorded = recordOrbitPath(doc, trackId, [{ tick: 0, x: 0, y: 0 }]).execute(doc);
    const lane = recorded.automation.find((candidate) => candidate.target.trackId === trackId)!;
    const before = lane.points[0]!.id;
    const updated = setAutomationPointAt(recorded, lane.id, 0, 0.75).execute(recorded);
    const laneAfter = updated.automation.find((candidate) => candidate.id === lane.id)!;
    expect(laneAfter.points[0]!.id).toBe(before);
  });

  it("undoes back to the point it overwrote", () => {
    const { doc, trackId } = tsarDoc();
    const recorded = recordOrbitPath(doc, trackId, [{ tick: 0, x: 0, y: 0 }]).execute(doc);
    const lane = recorded.automation.find((candidate) => candidate.target.trackId === trackId)!;
    const command = setAutomationPointAt(recorded, lane.id, 0, 0.75);
    const undone = command.undo(command.execute(recorded));
    const laneAfter = undone.automation.find((candidate) => candidate.id === lane.id)!;
    expect(laneAfter.points[0]!.value).toBeCloseTo(0, 6);
  });
});
