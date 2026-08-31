import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { createProjectFromTemplate } from "../src/project-model/templates";
import {
  addArrangementClip,
  addToGroup,
  createGroupTrack,
  setMasterConfig,
  setReturnGain,
  setTrackSend,
} from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { buildStemProject, nonEmptyStemGroups, STEM_GROUPS } from "../src/rendering/stems";
import { computeRenderTicks } from "../src/rendering/renderer";
import { BAR_TICKS, STEP_TICKS } from "../src/project-model/types";

describe("stem groups", () => {
  it("default project has drums, bass and music groups", () => {
    const doc = createDefaultProject();
    const groups = nonEmptyStemGroups(doc);
    expect(groups.map((g) => g.id)).toEqual(["drums", "bass", "music"]);
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
    const doc = createProjectFromTemplate("empty");
    const music = buildStemProject(doc, STEM_GROUPS[2].filter);
    expect(music.tracks).toHaveLength(0);
  });

  it("buildStemProject includes parent GroupTracks so grouped stems sum to the mix", () => {
    // Regression: stems filtered only by kind, so a grouped "Drums" stem
    // bypassed the group's gain/pan/FX and didn't sum to the master mix.
    // The offline renderer needs the group in the doc for correct routing
    // (same pattern as track-renderer.ts for frozen tracks).
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(createGroupTrack(store.doc));
    const groupId = store.doc.tracks[store.doc.tracks.length - 1].id;
    expect(store.doc.tracks[store.doc.tracks.length - 1].kind).toBe("group");
    const drumId = store.doc.tracks.find((t) => t.kind === "drum")!.id;
    store.execute(addToGroup(store.doc, drumId, groupId));
    const stem = buildStemProject(store.doc, STEM_GROUPS[0].filter);
    // The stem must contain BOTH the drum track and its parent group.
    expect(stem.tracks.some((t) => t.id === drumId)).toBe(true);
    expect(stem.tracks.some((t) => t.id === groupId)).toBe(true);
    expect(stem.tracks.some((t) => t.kind === "group")).toBe(true);
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
    expect(doc.returns.map((r) => r.name)).toEqual(["Reverb", "Delay", "NY Comp"]);
    expect(doc.master.limiterEnabled).toBe(true);
    expect(doc.master.clipperEnabled).toBe(false);
    expect(doc.tracks.every((t) => Object.keys(t.sends).length === 0)).toBe(true);
  });

  it("setMasterConfig toggles limiter and clipper with undo", () => {
    const doc = createDefaultProject();
    const store = new ProjectStore(doc);
    store.execute(setMasterConfig(store.doc, { clipperEnabled: true, limiterEnabled: false }));
    expect(store.doc.master).toMatchObject({
      masterGain: 1,
      ceilingDb: -1,
      limiterEnabled: false,
      clipperEnabled: true,
    });
    store.undo();
    expect(store.doc.master).toMatchObject({
      masterGain: 1,
      ceilingDb: -1,
      limiterEnabled: true,
      clipperEnabled: false,
    });
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
