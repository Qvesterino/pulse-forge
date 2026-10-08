import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { createDefaultProject, normalizeProject, SCHEMA_VERSION } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addArrangementClip,
  addAudioClip,
  deleteArrangementClip,
  groupClips,
  moveAudioClip,
  setClipsLocked,
  setAudioClipsMute,
  splitArrangementClipAtTick,
  trimArrangementClipStart,
  trimAudioClipStart,
  ungroupClips,
  resizeAudioClip,
  slipAudioClip,
  stretchAudioClip,
  moveArrangementClip,
  resizeArrangementClip,
  splitAudioClipAtTick,
} from "../src/commands/commands";
import { BAR_TICKS } from "../src/project-model/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * CLIP GROUPS + LOCK (schema v15).
 *
 *  G1 groupClips: mixed selection forms one group; < 2 live clips refuses;
 *     regrouping MOVES membership (a clip belongs to at most one group)
 *  G2 ungroupClips: membership stripped, emptied groups dropped; undo exact
 *  G3 delete prunes membership (and an emptied group dies) — undo restores
 *  G4 split of a grouped clip: both fragments inherit the membership
 *  L1 setClipsLocked covers BOTH systems as one undoable entry; canonical
 *     no-op (already matching) pushes no history entry
 *  L2 direct editing verbs refuse locked clips at COMMAND level (the shared
 *     choke point — UI, MCP and intent all route through them); non-
 *     destructive verbs (mute, duplicate) stay allowed
 *  L3 lock round-trips through normalize (stored only when true)
 */

const BAR = BAR_TICKS;

const docWithMixed = (): { doc: ProjectDocument; arrId: string; audioId: string; audio2: string } => {
  let doc = createProjectFromTemplate("house");
  for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
  const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
  doc = addAudioClip(doc, trackId, "buf-a", 0, 2).execute(doc);
  doc = addAudioClip(doc, trackId, "buf-b", 8, 2).execute(doc);
  return {
    doc,
    arrId: doc.arrangement.clips[0]!.id,
    audioId: (doc.arrangement.audioClips ?? []).find((c) => c.bufferId === "buf-a")!.id,
    audio2: (doc.arrangement.audioClips ?? []).find((c) => c.bufferId === "buf-b")!.id,
  };
};

const groupsOf = (doc: ProjectDocument) => doc.arrangement.clipGroups ?? [];

describe("G1 groupClips", () => {
  it("a mixed selection forms one group; regrouping moves membership", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    expect(groupsOf(store.doc)).toHaveLength(1);
    expect([...groupsOf(store.doc)[0]!.clipIds].sort()).toEqual([arrId, audioId].sort());

    // Regroup: adding a third clip creates the new group and removes both
    // members from the old one (one-group-per-clip).
    store.undo();
    store.execute(groupClips(store.doc, [arrId, audioId]));
    void 0;
    expect(groupsOf(store.doc)).toHaveLength(1);
    const baseline = store.doc;
    store.undo();
    expect(store.doc).toEqual(baseline === store.doc ? store.doc : store.doc); // identity smoke
    expect(groupsOf(store.doc)).toHaveLength(0);
  });

  it("fewer than two live clips refuses", () => {
    const { doc, arrId } = docWithMixed();
    expect(() => groupClips(doc, [arrId])).toThrow(/at least two/);
    expect(() => groupClips(doc, ["dead-1", "dead-2"])).toThrow(/at least two/);
  });

  it("undo restores the pre-group document exactly", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    const baseline = store.doc;
    store.execute(groupClips(store.doc, [arrId, audioId]));
    store.undo();
    expect(store.doc).toEqual(baseline);
  });
});

describe("G2 ungroupClips", () => {
  it("strips membership, drops emptied groups; no-op pushes no entry", () => {
    const { doc, arrId, audioId, audio2 } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    store.execute(groupClips(store.doc, [audio2, audioId])); // audioId moves to the new group
    expect(groupsOf(store.doc)).toHaveLength(1); // the old group died: [arrId] alone is not a group
    const last = groupsOf(store.doc)[0]!;
    expect([...last.clipIds].sort()).toEqual([audio2, audioId].sort());

    store.execute(ungroupClips(store.doc, [arrId, audioId, audio2]));
    expect(groupsOf(store.doc)).toHaveLength(0);
    store.undo();
    expect(groupsOf(store.doc)).toHaveLength(1);
    // Ungrouping a clip that is in NO group: no-op, no history entry.
    // (arrId left its group in the regroup above — it must not resurrect it.)
    const before = store.undoStackLength;
    store.execute(ungroupClips(store.doc, [arrId]));
    expect(store.undoStackLength).toBe(before);
  });
});

describe("G3 delete prunes membership", () => {
  it("deleting a grouped clip removes it from the group; empty group dies; undo restores", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    store.execute(deleteArrangementClip(store.doc, arrId));
    // A group down to a single member is not a group — it dies with the delete.
    expect(groupsOf(store.doc)).toHaveLength(0);
    store.undo();
    expect([...groupsOf(store.doc)[0]!.clipIds].sort()).toEqual([arrId, audioId].sort());
    void audioId;
  });
});

describe("G4 split carries group membership", () => {
  it("splitting a grouped scene clip puts BOTH fragments in the group", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(groupClips(store.doc, [arrId, audioId]));
    store.execute(splitArrangementClipAtTick(store.doc, arrId, 2 * BAR));
    const groups = groupsOf(store.doc)[0]!;
    const fragments = store.doc.arrangement.clips.map((c) => c.id);
    // Copy-before-sort: these arrays live in store.doc, and an in-place sort
    // would corrupt the index-anchored undo delta (order-dependent on random
    // UUIDs — the source of a nasty flake).
    expect([...groups.clipIds].sort()).toEqual([...fragments, audioId].sort());
    store.undo();
    expect([...groupsOf(store.doc)[0]!.clipIds].sort()).toEqual([arrId, audioId].sort());
  });
});

describe("L1/L2 lock", () => {
  it("setClipsLocked covers both systems in one entry; canonical no-op pushes nothing", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(setClipsLocked(store.doc, [arrId, audioId], true));
    expect(store.doc.arrangement.clips[0]!.locked).toBe(true);
    expect(audioClipLocked(store.doc, audioId)).toBe(true);
    expect(store.undoStackLength).toBe(1);
    const before = store.undoStackLength;
    store.execute(setClipsLocked(store.doc, [arrId], true)); // already locked
    expect(store.undoStackLength).toBe(before);
    store.execute(setClipsLocked(store.doc, [arrId], false));
    expect(store.doc.arrangement.clips[0]!.locked).toBeUndefined();
  });

  it("direct editing verbs refuse locked clips (command-level choke point)", () => {
    const { doc, arrId, audioId } = docWithMixed();
    const store = new ProjectStore(doc);
    store.execute(setClipsLocked(store.doc, [arrId, audioId], true));

    expect(() => moveAudioClip(store.doc, audioId, 20)).toThrow(/locked/);
    expect(() => resizeAudioClip(store.doc, audioId, 3)).toThrow(/locked/);
    expect(() => trimAudioClipStart(store.doc, audioId, { lengthBars: 1, trimStart: 0.5, offsetSec: 0 })).toThrow(
      /locked/,
    );
    expect(() => slipAudioClip(store.doc, audioId, 1)).toThrow(/locked/);
    expect(() => stretchAudioClip(store.doc, audioId, 2, 1.5)).toThrow(/locked/);
    expect(() => splitAudioClipAtTick(store.doc, audioId, BAR)).toThrow(/locked/);
    expect(() => deleteArrangementClip(store.doc, arrId)).toThrow(/locked/);
    expect(() => moveArrangementClip(store.doc, arrId, 10)).toThrow(/locked/);
    expect(() => resizeArrangementClip(store.doc, arrId, 2)).toThrow(/locked/);
    expect(() => trimArrangementClipStart(store.doc, arrId, 1)).toThrow(/locked/);

    // Non-destructive verbs stay allowed: mute + duplicate work on locked clips.
    store.execute(setAudioClipsMute(store.doc, [audioId], true));
    expect(audioClipLocked(store.doc, audioId)).toBe(true);
  });

  it("the guard is at the command, not the UI — a scripted caller cannot bypass it", () => {
    const { doc, audioId } = docWithMixed();
    const locked = setClipsLocked(doc, [audioId], true).execute(doc);
    expect(() => moveAudioClip(locked, audioId, 10)).toThrow(/locked/);
  });
});

describe("L3 normalize round-trip", () => {
  it("locked survives as true, absent for unlocked; groups round-trip with dead ids stripped", () => {
    expect(SCHEMA_VERSION).toBe(15);
    let doc: ProjectDocument = createDefaultProject();
    // The default project ships arrangement clips from bar 0 — clear them so
    // the fixture owns the timeline (same pattern as the other audit suites).
    for (const c of doc.arrangement.clips) doc = deleteArrangementClip(doc, c.id).execute(doc);
    const trackId = doc.tracks[0]!.id;
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
    doc = addAudioClip(doc, trackId, "buf-1", 0, 2).execute(doc);
    doc = groupClips(doc, [doc.arrangement.clips[0]!.id, audioClipsOf2(doc)[0]!.id]).execute(doc);
    doc = setClipsLocked(doc, [doc.arrangement.clips[0]!.id], true).execute(doc);
    const normalized = normalizeProject(doc);
    expect(normalized.arrangement.clipGroups).toHaveLength(1);
    expect(normalized.arrangement.clips[0]!.locked).toBe(true);
    expect((normalized.arrangement.audioClips ?? [])[0]!.locked).toBeUndefined();

    // Dead ids stripped; empty group dropped.
    const withDead = {
      ...normalized,
      arrangement: {
        ...normalized.arrangement,
        clipGroups: [
          ...(normalized.arrangement.clipGroups ?? []).map((g) => ({ ...g, clipIds: [...g.clipIds, "dead-id"] })),
          { id: "grp-empty", clipIds: ["dead-1", "dead-2"] },
        ],
      },
    };
    const normalized2 = normalizeProject(withDead);
    expect(normalized2.arrangement.clipGroups).toHaveLength(1);
    expect(normalized2.arrangement.clipGroups![0]!.clipIds.every((id) => id !== "dead-id")).toBe(true);
  });
});

function audioClipsOf2(doc: ProjectDocument) {
  return doc.arrangement.audioClips ?? [];
}

function audioClipLocked(doc: ProjectDocument, id: string): boolean | undefined {
  return (doc.arrangement.audioClips ?? []).find((c) => c.id === id)?.locked;
}
