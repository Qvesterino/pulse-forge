import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { planSongForm, buildSong, applySongCommand, previewSongForm, type SongBuild } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { getActivePattern } from "../src/project-model/types";
import type { Scene } from "../src/project-model/types";

const INTENT = normalizeIntent({ genre: "house", seed: "song-test", bpmRange: [140, 140] });

describe("song form planner", () => {
  it("is deterministic and genre-shaped", () => {
    expect(planSongForm(INTENT)).toEqual(planSongForm(normalizeIntent({ genre: "house", seed: "song-test" })));
    expect(planSongForm(INTENT).sections.map((section) => section.role)).toEqual([
      "intro",
      "build",
      "drop",
      "break",
      "build",
      "drop",
      "outro",
    ]);
    expect(planSongForm(normalizeIntent({ genre: "trap", seed: "x" })).sections.length).toBe(6);
    expect(planSongForm(normalizeIntent({ genre: "ambient", seed: "x" })).sections.length).toBe(5);
    expect(planSongForm(INTENT).totalBars).toBe(44);
  });

  it("shifts sliders relative to the base intent and clamps to 0..1", () => {
    // drop = base + 0.3 energy; break = base − 0.35
    const energetic = planSongForm(normalizeIntent({ genre: "house", seed: "x", energy: 0.9, density: 0.8 }));
    const drop = energetic.sections.find((section) => section.label === "Drop A")!;
    expect(drop.energyDelta).toBe(1); // 0.9 + 0.3 clamped
    expect(drop.densityDelta).toBe(1);
    const calm = planSongForm(normalizeIntent({ genre: "house", seed: "x", energy: 0.2 }));
    const intro = calm.sections[0];
    expect(intro.energyDelta).toBe(0); // 0.2 − 0.25 clamped to 0
    for (const section of [...energetic.sections, ...calm.sections]) {
      expect(section.energyDelta).toBeGreaterThanOrEqual(0);
      expect(section.energyDelta).toBeLessThanOrEqual(1);
      expect(section.densityDelta).toBeGreaterThanOrEqual(0);
      expect(section.densityDelta).toBeLessThanOrEqual(1);
    }
  });

  it("previewSongForm returns names and totals without generating", () => {
    const preview = previewSongForm({ genre: "techno", style: "acid", seed: "x" });
    expect(preview.name).toBe("techno acid — song");
    expect(preview.totalBars).toBe(44);
  });
});

describe("song builder", () => {
  it("generates related but distinct section patterns", async () => {
    const doc = testDoc();
    const progress: Array<[number, string, number]> = [];
    const build: SongBuild = await buildSong(doc, INTENT, {
      yieldBetweenSections: false,
      onProgress: (done, label, total) => progress.push([done, label, total]),
    });
    expect(build.sections.length).toBe(7);
    expect(progress.length).toBe(7);
    expect(progress[6]).toEqual([7, "Outro", 7]);
    // every section: full-length pattern in the same genre
    for (const section of build.sections) {
      expect(section.pattern.stepCount).toBe(section.stepCount);
      expect(section.stepCount).toBe(Math.min(256, section.bars * 16));
      expect(section.pattern.generation?.genre).toBe("house");
      expect(section.pattern.generation?.style).toBe(null);
    }
    // related: the two drops share the seed namespace but differ in content
    const dropA = build.sections.find((section) => section.label === "Drop A")!;
    const dropB = build.sections.find((section) => section.label === "Drop B")!;
    expect(dropA.pattern.generation?.seed).not.toBe(dropB.pattern.generation?.seed);
    expect(dropA.pattern.generation?.outputContentHash).not.toBe(dropB.pattern.generation?.outputContentHash);
    // bpm resolved from the intent range
    expect(build.resolvedBpm).toBe(140);
  }, 60_000);

  it("is deterministic for the same intent", async () => {
    const doc = testDoc();
    const first = await buildSong(doc, INTENT, { yieldBetweenSections: false });
    const second = await buildSong(doc, INTENT, { yieldBetweenSections: false });
    expect(first.sections.map((section) => section.pattern.generation?.outputContentHash)).toEqual(
      second.sections.map((section) => section.pattern.generation?.outputContentHash),
    );
  }, 60_000);
});

describe("applySongCommand", () => {
  it("installs patterns + scenes + contiguous clips + markers + transitions as ONE undo step", async () => {
    const doc = testDoc();
    const patternsBefore = doc.patterns.length;
    const scenesBefore = doc.scenes.length;
    const build = await buildSong(doc, INTENT, { yieldBetweenSections: false });
    const command = applySongCommand(doc, build);
    const next = command.execute(doc);

    // patterns
    expect(next.patterns.length).toBe(patternsBefore + 7);
    // scenes with roles + intensity
    const newScenes = next.scenes.slice(scenesBefore) as Scene[];
    expect(newScenes.length).toBe(7);
    expect(newScenes.map((scene) => scene.role)).toEqual(["intro", "build", "drop", "break", "build", "drop", "outro"]);
    expect(newScenes[2].intensity).toBe(0.9);
    expect(newScenes.map((scene) => scene.name)).toEqual([
      "Intro",
      "Build A",
      "Drop A",
      "Break",
      "Build B",
      "Drop B",
      "Outro",
    ]);
    // contiguous clips (no gaps, no overlaps), lengths match the form
    const clips = [...next.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    expect(clips.length).toBe(7);
    let bar = 0;
    for (const [index, clip] of clips.entries()) {
      expect(clip.startBar).toBe(bar);
      expect(clip.lengthBars).toBe(build.sections[index].bars);
      bar += clip.lengthBars;
    }
    expect(bar).toBe(44);
    // scenes reference their generated patterns
    for (const [index, clip] of clips.entries()) {
      const scene = next.scenes.find((scene) => scene.id === clip.sceneId)!;
      expect(scene.patternId).toBe(build.sections[index].pattern.id);
    }
    // markers at section starts + riser transitions into both drops
    expect(next.markers?.length).toBe(5);
    expect(next.markers?.map((marker) => marker.name)).toEqual(["BUILD A", "DROP A", "BREAK", "BUILD B", "DROP B"]);
    const dropA = newScenes[2];
    const dropAClip = clips.find((clip) => clip.sceneId === dropA.id)!;
    expect(
      next.arrangement.transitions?.filter((transition) => transition.toClipId === dropAClip.id).map((t) => t.type),
    ).toEqual(["riser"]);
    // bpm + active pattern
    expect(next.bpm).toBe(140);
    expect(getActivePattern(next)?.id).toBe(build.sections[6].pattern.id);

    // ONE undo restores everything
    const undone = command.undo(next);
    expect(undone.patterns.length).toBe(patternsBefore);
    expect(undone.scenes.length).toBe(scenesBefore);
    expect(undone.arrangement.clips.length).toBe(0);
    expect(undone.markers?.length ?? 0).toBe(0);
  }, 60_000);
});
