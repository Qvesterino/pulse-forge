import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import {
  addArrangementClip,
  setMasterConfig,
  setReturnGain,
  setTrackSend,
} from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { buildStemProject, nonEmptyStemGroups, STEM_GROUPS } from "../src/rendering/stems";
import { computeRenderTicks } from "../src/rendering/renderer";
import { BAR_TICKS, STEP_TICKS } from "../src/project-model/types";

describe("stem groups", () => {
  it("default project has drums and bass groups", () => {
    const doc = createDefaultProject();
    const groups = nonEmptyStemGroups(doc);
    expect(groups.map((g) => g.id)).toEqual(["drums", "bass"]);
  });

  it("buildStemProject keeps only matching tracks and clears solo", () => {
    const doc = createDefaultProject();
    const drumTrackId = doc.tracks[0].id;
    const stem = buildStemProject(doc, STEM_GROUPS[0].filter);
    expect(stem.tracks).toHaveLength(1);
    expect(stem.tracks[0].id).toBe(drumTrackId);
    expect(stem.tracks[0].solo).toBe(false);
    expect(stem.returns).toHaveLength(doc.returns.length);
    expect(stem.patterns).toEqual(doc.patterns);
  });

  it("music group is empty until a melodic instrument exists", () => {
    const doc = createDefaultProject();
    const music = buildStemProject(doc, STEM_GROUPS[2].filter);
    expect(music.tracks).toHaveLength(0);
  });
});

describe("render length", () => {
  it("pattern mode renders one pattern pass", () => {
    const doc = createDefaultProject();
    expect(computeRenderTicks(doc, "pattern")).toBe(16 * STEP_TICKS);
  });

  it("song mode renders the full arrangement", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(addArrangementClip(store.doc, doc.scenes[0].id, 4, 4));
    expect(computeRenderTicks(store.doc, "song")).toBe(8 * BAR_TICKS);
  });

  it("song mode falls back to the pattern when arrangement is empty", () => {
    const doc = createDefaultProject();
    const emptied = { ...doc, arrangement: { clips: [] } };
    expect(computeRenderTicks(emptied, "song")).toBe(16 * STEP_TICKS);
  });
});

describe("master and send commands", () => {
  it("default project ships returns, master config and empty sends", () => {
    const doc = createDefaultProject();
    expect(doc.returns.map((r) => r.name)).toEqual(["Reverb", "Delay"]);
    expect(doc.master.limiterEnabled).toBe(true);
    expect(doc.master.clipperEnabled).toBe(false);
    expect(doc.tracks.every((t) => Object.keys(t.sends).length === 0)).toBe(true);
  });

  it("setMasterConfig toggles limiter and clipper with undo", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(setMasterConfig(store.doc, { clipperEnabled: true, limiterEnabled: false }));
    expect(store.doc.master).toEqual({ limiterEnabled: false, clipperEnabled: true });
    store.undo();
    expect(store.doc.master).toEqual({ limiterEnabled: true, clipperEnabled: false });
  });

  it("setTrackSend clamps and undoes", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const trackId = doc.tracks[0].id;
    const returnId = doc.returns[0].id;
    store.execute(setTrackSend(store.doc, trackId, returnId, 5));
    expect(store.doc.tracks[0].sends[returnId]).toBe(1.5);
    store.undo();
    expect(store.doc.tracks[0].sends[returnId]).toBe(0);
  });

  it("setReturnGain round-trips", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    const returnId = doc.returns[0].id;
    store.execute(setReturnGain(store.doc, returnId, 0.4));
    expect(store.doc.returns[0].gain).toBeCloseTo(0.4, 5);
    store.undo();
    expect(store.doc.returns[0].gain).toBeCloseTo(0.9, 5);
  });
});
