import { describe, expect, it } from "vitest";
import { autoArrangeSong, assistVary, setSceneBpm } from "../src/commands/commands";
import { createDefaultProject } from "../src/project-model/schema";
import { sceneRoleOf } from "../src/project-model/schema";
import type { ProjectDocument } from "../src/project-model/types";

/** Project with named scenes — sceneRoleOf infers roles from names. */
function docWithScenes(...names: string[]): ProjectDocument {
  let doc = createDefaultProject();
  const scenes = names.map((name, i) => ({
    id: `scene-${i}-${name.toLowerCase()}`,
    name,
    patternId: doc.activePatternId,
    intensity: 0.7,
  }));
  doc = { ...doc, scenes };
  return doc;
}

describe("autoArrangeSong", () => {
  it("lays a full song when every role is present (order, lengths, transitions, markers)", () => {
    const doc = docWithScenes("Intro", "Build", "Drop", "Break", "Outro");
    const next = autoArrangeSong(doc).execute(doc);
    const clips = next.arrangement.clips;
    expect(clips.map((c) => c.lengthBars)).toEqual([4, 4, 8, 4, 4, 8, 4]);
    // 7 sections, all transitions present between neighbours, drop/build markers set.
    // intro→build has no transition by design; the 6 later boundaries have 5.
    const transitionTypes = next.arrangement.transitions!.map((t) => t.type);
    expect(transitionTypes).toEqual(["riser", "break", "fill", "riser", "break"]);
    const markerTypes = next.markers.map((m) => m.type);
    expect(markerTypes).toContain("drop");
    expect(markerTypes).toContain("buildup");
    expect(next.markers.every((m) => Number.isFinite(m.tick) && m.tick >= 0)).toBe(true);
    // Clips are contiguous from bar 0.
    let bar = 0;
    for (const clip of clips) {
      expect(clip.startBar).toBe(bar);
      bar += clip.lengthBars;
    }
  });

  it("reuses scenes across slots when roles are missing (3-scene jam → full song)", () => {
    const doc = docWithScenes("Kick Jam", "Snare Roll", "Hats");
    const next = autoArrangeSong(doc).execute(doc);
    expect(next.arrangement.clips.length).toBe(7);
    // Every clip references a scene that exists.
    for (const clip of next.arrangement.clips) {
      expect(doc.scenes.some((s) => s.id === clip.sceneId)).toBe(true);
    }
  });

  it("cycles multiple drop scenes into DROP A / DROP B", () => {
    const doc = docWithScenes("Intro", "Build", "Drop One", "Drop Two", "Break", "Outro");
    const next = autoArrangeSong(doc).execute(doc);
    const dropClips = next.arrangement.clips.filter((clip) => {
      const scene = next.scenes.find((s) => s.id === clip.sceneId)!;
      return sceneRoleOf(scene) === "drop";
    });
    const dropNames = dropClips.map((clip) => next.scenes.find((s) => s.id === clip.sceneId)!.name);
    expect(dropNames).toEqual(["Drop One", "Drop Two"]);
  });

  it("throws with zero scenes and supports undo", () => {
    const bare = { ...createDefaultProject(), scenes: [] };
    expect(() => autoArrangeSong(bare as never)).toThrow(/No scenes/u);
    const doc = docWithScenes("Intro", "Build", "Drop", "Break", "Outro");
    const command = autoArrangeSong(doc);
    const next = command.execute(doc);
    const undone = command.undo(next);
    expect(undone.arrangement.clips).toEqual(doc.arrangement.clips);
    expect(undone.markers).toEqual(doc.markers);
  });
});

describe("assistVary — live variation primitive", () => {
  it("rewrites the scene's pattern content in place (undoable)", () => {
    const doc = createDefaultProject();
    const patternId = doc.activePatternId;
    const command = assistVary(doc, patternId, "test-seed", 0.5);
    const next = command.execute(doc);
    const varied = next.patterns.find((p) => p.id === patternId)!;
    const before = doc.patterns.find((p) => p.id === patternId)!;
    // Deterministic seed → the same content each time.
    expect(varied).toEqual(command.execute(doc).patterns.find((p) => p.id === patternId)!);
    expect(varied).not.toEqual(before); // something actually changed
    expect(command.undo(next).patterns.find((p) => p.id === patternId)).toEqual(before);
  });

  it("composes with scene tempo (variation keeps the scene's bpm)", () => {
    let doc = createDefaultProject();
    const sceneId = doc.scenes[0].id;
    doc = setSceneBpm(doc, sceneId, 140).execute(doc);
    const patternId = doc.scenes[0].patternId;
    const next = assistVary(doc, patternId, "seed", 0.5).execute(doc);
    expect(next.scenes.find((s) => s.id === sceneId)!.bpm).toBe(140);
  });
});
