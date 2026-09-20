import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import {
  planSongForm,
  buildSong,
  applySongCommand,
  previewSongForm,
  reviseSection,
  replacePatternInPlaceCommand,
  type SongBuild,
} from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { getActivePattern } from "../src/project-model/types";
import type { Pattern, Scene } from "../src/project-model/types";

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
    expect(planSongForm(normalizeIntent({ genre: "trap", seed: "x" })).sections.length).toBe(8);
    expect(planSongForm(normalizeIntent({ genre: "ambient", seed: "x" })).sections.length).toBe(5);
    expect(planSongForm(INTENT).totalBars).toBe(44);
  });

  it("every section carries role-aware instrumentation (A2 v2)", () => {
    const form = planSongForm(INTENT);
    const byLabel = Object.fromEntries(form.sections.map((section) => [section.label, section]));
    expect(byLabel["Intro"].instrumentation).toEqual(["drums", "bass"]);
    expect(byLabel["Drop A"].instrumentation).toEqual(["drums", "bass", "chords", "lead"]);
    expect(byLabel["Break"].instrumentation).toEqual(["chords", "lead"]);
    // trap uses the POP form: verse/chorus/bridge are first-class
    const trap = planSongForm(normalizeIntent({ genre: "trap", seed: "x" }));
    expect(trap.sections.map((section) => section.role)).toEqual([
      "intro",
      "verse",
      "chorus",
      "verse",
      "chorus",
      "bridge",
      "chorus",
      "outro",
    ]);
    const chorus = trap.sections.find((section) => section.role === "chorus")!;
    expect(chorus.instrumentation).toEqual(["drums", "bass", "chords", "lead"]);
    const bridge = trap.sections.find((section) => section.role === "bridge")!;
    expect(bridge.instrumentation).toEqual(["chords", "lead"]);
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

function barHits(pattern: Pattern, bar: number): { count: number } {
  let count = 0;
  for (const row of Object.values(pattern.rows)) {
    for (let step = bar * 16; step < (bar + 1) * 16 && step < row.length; step++) {
      if (row[step] > 0) count += 1;
    }
  }
  return { count };
}

describe("role-aware instrumentation (A2 v2)", () => {
  const POP_INTENT = normalizeIntent({ genre: "trap", seed: "pop-song", bpmRange: [140, 140] });

  it("chorus sections play the lead, verse sections do not", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, POP_INTENT, { yieldBetweenSections: false });
    for (const section of build.sections) {
      // provenance: the roles ACTUALLY generated match the section form
      if (section.role === "chorus") expect(section.roles).toContain("lead");
      if (section.role === "verse") expect(section.roles).not.toContain("lead");
      if (section.role === "bridge") {
        expect(section.roles).toEqual(["chords", "lead"]);
        // bridge BODY strips drums; the LAST bar may carry the baked launch
        // fill into the next chorus (T3 transition sound — drum-free sections
        // elsewhere stay clean)
        const bars = section.stepCount / 16;
        for (let bar = 0; bar < bars - 1; bar++) {
          expect(barHits(section.pattern, bar).count).toBe(0);
        }
        expect(Object.keys(section.pattern.notes ?? {}).length).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it("user role requests cut across every section (no drums → no drums anywhere)", async () => {
    const doc = testDoc();
    const build = await buildSong(
      doc,
      normalizeIntent({ genre: "trap", seed: "nodrums", roles: ["bass", "chords", "lead"] }),
      {
        yieldBetweenSections: false,
      },
    );
    for (const section of build.sections) {
      const hitCount = Object.values(section.pattern.rows).reduce(
        (sum, row) => sum + row.filter((velocity) => velocity > 0).length,
        0,
      );
      expect(hitCount).toBe(0);
    }
  }, 60_000);

  it("scenes carry the new songwriting roles into the arrangement", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, POP_INTENT, { yieldBetweenSections: false });
    const next = applySongCommand(doc, build).execute(doc);
    const roles = next.scenes.slice(doc.scenes.length).map((scene) => scene.role);
    expect(roles).toContain("verse");
    expect(roles).toContain("chorus");
    expect(roles).toContain("bridge");
  }, 60_000);
});

describe("scene role persistence (A2 v2)", () => {
  it("clampSceneRole accepts the songwriting roles and keeps old ones", async () => {
    const { clampSceneRole } = await import("../src/project-model/schema");
    expect(clampSceneRole("verse")).toBe("verse");
    expect(clampSceneRole("chorus")).toBe("chorus");
    expect(clampSceneRole("bridge")).toBe("bridge");
    // backward compat: legacy roles survive loading
    expect(clampSceneRole("drop")).toBe("drop");
    expect(clampSceneRole("build")).toBe("build");
    expect(clampSceneRole("nonsense")).toBeUndefined();
    // older scenes named "Chorus" now infer their own role
    const { inferSceneRole } = await import("../src/project-model/schema");
    expect(inferSceneRole("Chorus 1")).toBe("chorus");
    expect(inferSceneRole("VERSE")).toBe("verse");
    expect(inferSceneRole("Bridge")).toBe("bridge");
    expect(inferSceneRole("Drop A")).toBe("drop");
  });
});

describe("targeted section revise (C3)", () => {
  it("regenerates ONE section in place from its provenance intent", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, normalizeIntent({ genre: "trap", seed: "c3", bpmRange: [140, 140] }), {
      yieldBetweenSections: false,
    });
    // install the song so the doc has real scenes bound to patterns
    const withSong = applySongCommand(doc, build).execute(withDocBpm(doc, build));
    // NB: use a section WITH drums — density shifts ghostWeight, which the
    // drum engine honors. Energy on a melodic-only section (bridge) is a
    // known mapping gap (melodic velocities don't read velocityVariation yet).
    const verseScene = withSong.scenes.find((scene) => scene.role === "verse")!;
    const verseBefore = withSong.patterns.find((pattern) => pattern.id === verseScene.patternId)!;
    const seedBefore = verseBefore.generation?.seed;
    const densityBefore = (verseBefore.generation?.intent as { density: number }).density;

    const outcome = reviseSection(withSong, "verse", "density", 0.15);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // identity: SAME id, SAME seed; character: density moved, content changed
    expect(outcome.patternId).toBe(verseScene.patternId);
    expect(outcome.pattern.id).toBe(verseScene.patternId);
    expect(outcome.pattern.generation?.seed).toBe(seedBefore);
    const densityAfter = (outcome.pattern.generation?.intent as { density: number }).density;
    expect(densityAfter).toBeCloseTo(densityBefore + 0.15, 5);
    expect(outcome.pattern.generation?.outputContentHash).not.toBe(verseBefore.generation?.outputContentHash);

    const command = replacePatternInPlaceCommand(withSong, outcome.patternId, outcome.pattern);
    const next = command.execute(withSong);
    // scene + clip stay bound to the SAME pattern id
    expect(next.scenes.find((scene) => scene.id === verseScene.id)!.patternId).toBe(verseScene.patternId);
    const revised = next.patterns.find((pattern) => pattern.id === verseScene.patternId)!;
    expect(revised.generation?.outputContentHash).toBe(outcome.pattern.generation?.outputContentHash);
    // ONE undo restores the pre-revision content
    const undone = command.undo(next);
    const restored = undone.patterns.find((pattern) => pattern.id === verseScene.patternId)!;
    expect(restored.generation?.outputContentHash).toBe(verseBefore.generation?.outputContentHash);
  }, 60_000);

  it("reports a friendly error when the role does not exist", () => {
    const outcome = reviseSection(testDoc(), "bridge", "energy", 0.15);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("no bridge section");
  });
});

function withDocBpm(doc: Parameters<typeof applySongCommand>[0], build: { resolvedBpm: number | null }) {
  return build.resolvedBpm != null ? { ...doc, bpm: build.resolvedBpm } : doc;
}
