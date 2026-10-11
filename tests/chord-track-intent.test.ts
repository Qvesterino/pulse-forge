import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import { normalizeIntent } from "../src/intent/normalize";
import { buildSong, applySongCommand } from "../src/intent/song";
import { chordName } from "../src/project-model/chords";
import type { ChordEvent, ProjectDocument } from "../src/project-model/types";

/**
 * INTENT → CHORD TRACK (v2): a generated song lays its harmony plan onto the
 * chord lane — verse progression per section, the bridge takes the related
 * turn; tonic/mode resolve from the build's MusicalKey; the chord track IS
 * the song's harmonic plan (the song rebuild owns the timeline).
 *
 *  I1 the chord lane spans the whole song: starts at bar 0, whole bars,
 *     adjacent (no gaps, no overlaps), ends at totalBars
 *  I2 tonic: the build key's tonic is the FIRST chord's root pitch class
 *  I3 the bridge section plays the TURN progression (different root/quality
 *     pattern than verse sections)
 *  I4 undo restores the pre-song document exactly
 *  I5 without a key the chord track stays empty (no assumed harmony)
 */

const buildAndApply = async (
  _input: Parameters<typeof normalizeIntent>[0],
  key: ProjectDocument["key"] | undefined,
): Promise<{
  before: ProjectDocument;
  after: ProjectDocument;
  store: import("../src/store/ProjectStore").ProjectStore;
  build: Awaited<ReturnType<typeof buildSong>>;
}> => {
  const doc = createProjectFromTemplate("empty");
  const store = new ProjectStore(doc);
  const before = store.doc;
  const build = await buildSong(
    store.doc,
    normalizeIntent({ genre: "house", seed: "chord-intent", bpmRange: [124, 124] }),
    {
      yieldBetweenSections: false,
    },
  );
  const buildWithKey: typeof build = { ...build, key: key ?? null };
  store.execute(applySongCommand(store.doc, buildWithKey));
  return { before, after: store.doc, store, build };
};

const chordsOf = (doc: ProjectDocument): ChordEvent[] => doc.arrangement.chords ?? [];

describe("I1/I2 the chord lane mirrors the song's harmony plan", () => {
  it("spans the song exactly: bar 0 start, adjacent whole bars, ends at totalBars", async () => {
    const { after } = await buildAndApply({ genre: "house", seed: "i1" }, "A Natural Minor");
    const chords = chordsOf(after);
    expect(chords.length).toBeGreaterThan(0);
    expect(chords[0]!.startBar).toBe(0);
    let cursor = 0;
    for (const chord of chords) {
      expect(chord.startBar).toBe(cursor); // adjacent, whole bars, no overlap
      expect(chord.lengthBars).toBeGreaterThanOrEqual(1);
      cursor = chord.startBar + chord.lengthBars;
    }
    // The song's arrangement ends where the chords end (the plan IS the song).
    const songEnd = Math.max(...after.arrangement.clips.map((c) => c.startBar + c.lengthBars));
    expect(cursor).toBe(songEnd);
  });

  it("the build key's tonic is the first chord's root pitch class", async () => {
    const { after } = await buildAndApply({ genre: "house", seed: "i2" }, "F# Natural Minor");
    const first = chordsOf(after)[0]!;
    expect(first.root).toBe(6); // F# tonic
    expect(chordName(first.root, first.quality).startsWith("F#")).toBe(true);
  });

  it("a major key resolves the major scale (D Major → tonic 2)", async () => {
    const { after } = await buildAndApply({ genre: "house", seed: "i2b" }, "D Major");
    expect(chordsOf(after)[0]!.root).toBe(2);
  });
});

describe("I3 the bridge plays the turn progression", () => {
  it("a bridge section plays the TURN progression — different chords than the verse", async () => {
    const doc = createProjectFromTemplate("empty");
    const store0 = new (await import("../src/store/ProjectStore")).ProjectStore(doc);
    const build = await buildSong(
      store0.doc,
      normalizeIntent({ genre: "trap", seed: "chord-intent", bpmRange: [140, 140] }),
      { yieldBetweenSections: false },
    );
    const store = new (await import("../src/store/ProjectStore")).ProjectStore(doc);
    const buildWithKey: typeof build = { ...build, key: "A Natural Minor" };
    store.execute(applySongCommand(store.doc, buildWithKey));
    const after = store.doc;
    const bridgeClips = after.arrangement.clips.filter((c) => {
      const scene = after.scenes.find((s) => s.id === c.sceneId);
      return scene?.role === "bridge";
    });
    expect(bridgeClips.length).toBeGreaterThan(0);
    const verseClips = after.arrangement.clips.filter((c) => {
      const scene = after.scenes.find((s) => s.id === c.sceneId);
      return scene?.role !== "bridge";
    });
    const chordSignature = (clip: ProjectDocument["arrangement"]["clips"][number]): string =>
      JSON.stringify(
        chordsOf(after)
          .filter((chord) => chord.startBar >= clip.startBar && chord.startBar < clip.startBar + clip.lengthBars)
          .map((chord) => [chord.root, chord.quality]),
      );
    const bridgeSignature = chordSignature(bridgeClips[0]);
    const verseSignature = chordSignature(verseClips[0]);
    expect(bridgeSignature).not.toBe(verseSignature);
  });
});

describe("I4/I5 undo and key-less honesty", () => {
  it("undo restores the pre-song document exactly (chords included)", async () => {
    const { before, after, store } = await buildAndApply({ genre: "house", seed: "i4" }, "A Natural Minor");
    expect(chordsOf(after).length).toBeGreaterThan(0);
    store.undo();
    expect(store.doc).toEqual(before);
    expect(chordsOf(store.doc)).toHaveLength(0);
  });

  it("without a build key the chord track stays empty (no assumed harmony)", async () => {
    const { after } = await buildAndApply({ genre: "house", seed: "i5" }, undefined);
    expect(chordsOf(after)).toHaveLength(0);
  });
});
