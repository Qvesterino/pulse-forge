/**
 * Project invariants — the three load-bearing properties called out in the
 * hardening review. Each `describe` is the PIN for one invariant: if a future
 * feature breaks it, this file must fail loudly BEFORE the scheduler or the
 * persistence layer does.
 *
 * 1. `getActivePattern` never throws on a normalized doc.
 * 2. `testDoc()` is canonical — `normalizeProject(testDoc()) === testDoc`.
 * 3. `placeClipAt` never throws "Clip overlaps" regardless of bar.
 *
 * Rules for contributors:
 *   - Any new command/adapter/import that can produce a dangling
 *     `activePatternId` or a stale scene/clip reference must add a case to
 *     section 1.
 *   - Perf assertions are smoke ceilings (500 ms / 250 ms), NOT tight
 *     budgets. The deterministic invariant (zero Y.Doc writes on a warm
 *     apply) is the real guard — see `collab-hardening.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { getActivePattern } from "../src/project-model/types";
import {
  addArrangementClip,
  createPattern,
  deletePattern,
  deleteTrack,
  freezeTrack,
  renamePattern,
  setActivePattern,
  setBpm,
} from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import type { ProjectDocument } from "../src/project-model/types";
import { YDocStore } from "../src/collab/YDocStore";
import {
  activePatternOf,
  commandHarness,
  deterministicTestDoc,
  drumTrackOf,
  placeClipAt,
  testDoc,
} from "./fixtures/doc";

// ─── 1. getActivePattern invariant ─────────────────────────────────────────

describe("invariant — getActivePattern", () => {
  it("throws on a dangling activePatternId (documents the contract)", () => {
    const doc = testDoc();
    const dangling = { ...doc, activePatternId: "ghost-pattern" };
    expect(() => getActivePattern(dangling)).toThrow(/Active pattern ghost-pattern not found/);
  });

  it("never throws after normalizeProject", () => {
    const doc = testDoc();
    const dangling = { ...doc, activePatternId: "ghost-pattern" };
    const normalized = normalizeProject(dangling);
    expect(() => getActivePattern(normalized)).not.toThrow();
    expect(normalized.activePatternId).toBe(normalized.patterns[0].id);
  });

  it("YDocStore repairs a dangling activePatternId injected by a foreign peer", () => {
    const store = YDocStore.fromDocument(testDoc());
    store.yDocRef.transact(() => {
      store.yDocRef.getMap("project").set("activePatternId", "ghost-pattern");
    });
    expect(() => getActivePattern(store.doc)).not.toThrow();
    expect(store.doc.activePatternId).toBe(store.doc.patterns[0].id);
  });

  it("deletePattern never leaves a dangling activePatternId", () => {
    const h = commandHarness();
    const victimId = h.doc.patterns[0].id;
    // Ensure at least two patterns so deletion is legal.
    if (h.doc.patterns.length < 2) {
      h.run(createPattern(h.doc, "Extra"));
    }
    const cmd = deletePattern(h.doc, victimId);
    const result = cmd.execute(h.doc);
    expect(() => getActivePattern(result)).not.toThrow();
  });

  it("setActivePattern ignores a non-existent id (no dangling write)", () => {
    const doc = testDoc();
    const cmd = setActivePattern(doc, "ghost-pattern");
    const result = cmd.execute(doc);
    expect(result.activePatternId).toBe(doc.activePatternId);
    expect(() => getActivePattern(result)).not.toThrow();
  });
});

// ─── 2. testDoc canonical invariant ────────────────────────────────────────

describe("invariant — testDoc canonical", () => {
  it("testDoc() is already normalized (reference identity)", () => {
    const doc = testDoc();
    expect(normalizeProject(doc)).toBe(doc);
  });

  it("deterministicTestDoc() is also canonical and cross-instance ids align", () => {
    const a = deterministicTestDoc();
    const b = deterministicTestDoc();
    expect(normalizeProject(a)).toBe(a);
    expect(a.patterns[0].id).toBe(b.patterns[0].id);
    expect(drumTrackOf(a).id).toBe(drumTrackOf(b).id);
  });
});

// ─── 3. placeClipAt / empty-arrangement invariant ──────────────────────────

describe("invariant — arrangement clips", () => {
  it("testDoc has an empty arrangement", () => {
    expect(testDoc().arrangement.clips).toHaveLength(0);
  });

  it("placeClipAt never throws overlap regardless of requested bar", () => {
    let doc = testDoc();
    // Fill bars 0..4 with a clip, then ask for bar 0 again — must hop past it.
    doc = placeClipAt(doc, doc.scenes[0].id, 0, 4);
    expect(doc.arrangement.clips).toHaveLength(1);
    doc = placeClipAt(doc, doc.scenes[0].id, 0, 2);
    expect(doc.arrangement.clips).toHaveLength(2);
    expect(doc.arrangement.clips[1].startBar).toBeGreaterThanOrEqual(4);
  });

  it("raw addArrangementClip at bar 0 on house DOES throw (documents the trap)", () => {
    // house template ships with a clip at bar 0; any new clip there must overlap.
    const houseDoc = createProjectFromTemplate("house");
    expect(houseDoc.arrangement.clips.length).toBeGreaterThan(0);
    expect(() => addArrangementClip(houseDoc, houseDoc.scenes[0].id, 0, 2).execute(houseDoc)).toThrow(/overlaps/);
  });
});

// ─── Fixture helpers — commandHarness + accessors ──────────────────────────

describe("fixtures — commandHarness & accessors", () => {
  it("harness keeps build-from and execute-on the same doc", () => {
    const h = commandHarness();
    h.run(setBpm(h.doc, 140));
    h.run(renamePattern(h.doc, h.doc.patterns[0].id, "Harness"));
    expect(h.doc.bpm).toBe(140);
    expect(activePatternOf(h.doc).name).toBe("Harness");
    h.undo();
    expect(activePatternOf(h.doc).name).not.toBe("Harness");
  });

  it("accessors throw with context instead of leaking undefined", () => {
    const empty: any = { tracks: [], patterns: [], scenes: [], arrangement: { clips: [] } };
    expect(() => drumTrackOf(empty as any)).toThrow(/drum track/);
    expect(() => activePatternOf(empty as any)).toThrow(/activePatternId/);
  });
});

// ─── 4. No orphaned audio clips (state-invariant audit) ────────────────────

describe("invariant — arrangement.audioClips ownership", () => {
  it("deleteTrack removes audio clips routed at the track (no persisted orphans)", () => {
    // The engine no-ops clips whose track is gone, but the dead references
    // used to survive every save until the next reload's normalize pass —
    // the saved doc violated the model invariant.
    const doc = testDoc();
    const track = doc.tracks[1]; // not the only track
    const withClips = {
      ...doc,
      arrangement: {
        clips: [],
        audioClips: [
          {
            id: "audio-keep",
            trackId: doc.tracks[0].id,
            bufferId: "buf-1",
            startBar: 0,
            lengthBars: 2,
            offsetSec: 0,
            trimStart: 0,
            trimEnd: 1,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            stretchRate: 1,
            reverse: false,
          },
          {
            id: "audio-drop",
            trackId: track.id,
            bufferId: "buf-2",
            startBar: 4,
            lengthBars: 1,
            offsetSec: 0,
            trimStart: 0,
            trimEnd: 1,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            stretchRate: 1,
            reverse: false,
          },
        ],
      },
    } as ProjectDocument;

    const store = new ProjectStore(withClips);
    store.execute(deleteTrack(withClips, track.id));

    const ids = (store.doc.arrangement.audioClips ?? []).map((c) => c.id);
    expect(ids).toEqual(["audio-keep"]);
    // And the whole deletion stays undoable.
    store.undo();
    expect((store.doc.arrangement.audioClips ?? []).map((c) => c.id)).toEqual(["audio-keep", "audio-drop"]);
  });
});

describe("invariant — frozen state ownership (state-invariant audit)", () => {
  it("freezeTrack rejects group tracks (their rendered buffer would be silence)", () => {
    const doc = testDoc();
    const group: ProjectDocument = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: "group-x",
          kind: "group",
          name: "Bus",
          gain: 1,
          pan: 0,
          mute: false,
          solo: false,
          effects: [],
          sends: {},
        },
      ],
    };
    expect(() => freezeTrack(group, "group-x", "buf-x", 4, 44100)).toThrow(/cannot be frozen/);
  });

  it("normalizeProject strips frozen state from group tracks (migration for poisoned projects)", () => {
    const doc = testDoc();
    const poisoned = {
      ...doc,
      tracks: [
        ...doc.tracks,
        {
          id: "group-y",
          kind: "group",
          name: "Bus",
          gain: 1,
          pan: 0,
          mute: false,
          solo: false,
          effects: [],
          sends: {},
          frozen: { bufferId: "buf-y", durationSec: 4, sampleRate: 44100 },
        },
      ],
    } as ProjectDocument;
    const healed = normalizeProject(poisoned);
    const group = healed.tracks.find((t) => t.kind === "group") as Record<string, unknown> | undefined;
    expect(group).toBeDefined();
    expect("frozen" in group!).toBe(false);
    // Idempotent: a second pass changes nothing.
    expect(normalizeProject(healed)).toEqual(healed);
  });
});
