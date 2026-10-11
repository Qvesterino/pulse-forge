import { describe, expect, it } from "vitest";
import { ProjectStore } from "../src/store/ProjectStore";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { addArrangementClip, moveArrangementClip } from "../src/commands/arrangement";
import { addAudioClip } from "../src/commands/audioClips";
import type { ArrangementClip, ProjectDocument } from "../src/project-model/types";

/**
 * THE SANITIZATION BOUNDARY — the line that decides what malformed project
 * data can ever reach the editor.
 *
 * `ProjectStore` runs `normalizeProject` at construction, on every `execute`,
 * on `undo`, on `redo` and on `replaceDoc`, so this boundary is what every UI
 * component, the renderer and the audio engine may assume. It is measured
 * here rather than assumed, because its exact shape decides which hostile
 * values are still a render problem:
 *
 *   startBar NaN / ±Infinity → clip DROPPED
 *   startBar 1e308          → clip KEPT (finite!)
 *   lengthBars ≤ 0 / NaN    → clip DROPPED
 *   audio clip NaN startBar → clip DROPPED
 *
 * The `1e308` row is the whole point. A non-finite position cannot reach the
 * timeline, but a large FINITE one sails through every sanitizer in the system
 * — which is why D12 (`RangeError: Invalid array length` from
 * `Array.from({ length: totalBars })`) was a reachable crash rather than a
 * theoretical one. This file exists so nobody "simplifies" the boundary
 * without re-measuring what it lets through.
 */

function docWithClip(overrides: Partial<ArrangementClip> = {}): ProjectDocument {
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [], audioClips: [] } };
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 8).execute(doc);
  return {
    ...doc,
    arrangement: {
      ...doc.arrangement,
      clips: doc.arrangement.clips.map((clip) => ({ ...clip, ...overrides })),
    },
  };
}

const storedClips = (doc: ProjectDocument) => new ProjectStore(doc).doc.arrangement.clips;

describe("the sanitization boundary", () => {
  it("CONTROL: a well-formed clip passes through untouched", () => {
    const doc = docWithClip({ startBar: 4, lengthBars: 8 });
    const clips = storedClips(doc);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.startBar).toBe(4);
    expect(clips[0]!.lengthBars).toBe(8);
  });

  it("drops a clip whose startBar is not a number", () => {
    for (const startBar of [Number.NaN, Infinity, -Infinity]) {
      expect(storedClips(docWithClip({ startBar })), `startBar=${String(startBar)}`).toHaveLength(0);
    }
  });

  it("drops a clip that has no positive duration", () => {
    for (const lengthBars of [0, -2, Number.NaN]) {
      expect(storedClips(docWithClip({ lengthBars })), `lengthBars=${String(lengthBars)}`).toHaveLength(0);
    }
  });

  it("KEPS an absurd but finite position — the reachable hostile case", () => {
    const clips = storedClips(docWithClip({ startBar: 1e308 }));
    expect(clips, "this is the value that reaches the render path").toHaveLength(1);
    expect(Number.isFinite(clips[0]!.startBar)).toBe(true);
    // Pinned deliberately: if a future sanitizer clamps this, D12's render
    // tolerance is still wanted, but this spec is what tells you the clamp
    // happened and the threat model moved.
    expect(clips[0]!.startBar).toBe(1e308);
  });

  it("applies the same boundary to audio clips", () => {
    let doc = createProjectFromTemplate("house");
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioClip(doc, trackId, "sanitize-buf", 0, 2, {}).execute(doc);
    const corrupted: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: doc.arrangement.audioClips!.map((clip) => ({ ...clip, startBar: Number.NaN })),
      },
    };
    expect(corrupted.arrangement.audioClips).toHaveLength(1);
    expect(new ProjectStore(corrupted).doc.arrangement.audioClips ?? []).toHaveLength(0);
  });

  it("every clip that SURVIVES the boundary is drawable — the invariant, as a property", () => {
    const clips = storedClips(
      docWithClip({
        startBar: 1e308,
      }),
    ).concat(
      new ProjectStore(
        docWithClip({
          startBar: -Number.MAX_VALUE,
        }),
      ).doc.arrangement.clips,
    );
    for (const clip of clips) {
      expect(Number.isFinite(clip.startBar), "survivors must have a real position").toBe(true);
      expect(Number.isFinite(clip.lengthBars), "survivors must have a real duration").toBe(true);
      expect(clip.lengthBars, "survivors must have a positive duration").toBeGreaterThan(0);
    }
  });

  it("a command that writes a non-finite position cannot corrupt the store", () => {
    // Commands are expected to clamp, but the store is the backstop: even a
    // buggy factory cannot leave a NaN in the document every UI layer reads.
    const doc = docWithClip();
    const store = new ProjectStore(doc);
    const clipId = store.doc.arrangement.clips[0]!.id;
    store.execute({
      type: "moveClips",
      label: "hostile move",
      execute: (d) => ({
        ...d,
        arrangement: {
          ...d.arrangement,
          clips: d.arrangement.clips.map((c) => (c.id === clipId ? { ...c, startBar: Number.NaN } : c)),
        },
      }),
      undo: (d) => d,
    });
    expect(store.doc.arrangement.clips.every((c) => Number.isFinite(c.startBar))).toBe(true);
  });

  it("a real command still produces exactly one undoable move", () => {
    const doc = docWithClip();
    const store = new ProjectStore(doc);
    const clipId = store.doc.arrangement.clips[0]!.id;
    const startBar = store.doc.arrangement.clips[0]!.startBar;
    store.execute(moveArrangementClip(store.doc, clipId, startBar + 4));
    expect(store.doc.arrangement.clips[0]!.startBar).toBe(startBar + 4);
    store.undo();
    expect(store.doc.arrangement.clips[0]!.startBar).toBe(startBar);
  });
});
