import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { getDocIndex } from "../src/project-model/doc-index";
import { soloAudibility } from "../src/project-model/solo-audibility";
import { targetOwner } from "../src/project-model/targets";
import { MASTER_EFFECT_OWNER_ID } from "../src/project-model/types";
import type { ProjectDocument, Track } from "../src/project-model/types";

/**
 * THE SHARED DOCUMENT INDEX — the mechanism behind the performance-cliff
 * fixes (docs/PERFORMANCE_CLIFF_DETECTOR_REPORT.md, C-1 / priority 1 and 2).
 *
 * The defect was never knowledge: `normalizeArrangementDomain` already built
 * `scenesById` / `patternsById` maps and used them inside its per-clip map.
 * The problem was that the one-line `doc.tracks.find(...)` is always writable
 * and a shared index is not. So the fix is a MECHANISM — one derived index per
 * document version, invalidated for free by the copy-on-write architecture
 * the delta engine already established.
 *
 * Three things are pinned here, and the order matters:
 *
 *   1. THE ANSWER MUST NOT CHANGE. The reference implementation below is the
 *      pre-index audibility rule, verbatim. The index is an optimization; the
 *      rule that decides what is audible is a product contract.
 *   2. THE SCAN MUST BE GONE. A count, not a millisecond — deterministic and
 *      independent of how busy the machine is.
 *   3. THE GUARD MUST BE ABLE TO FIRE. Every count assertion is paired with a
 *      positive control that proves the spy sees a scan when one happens.
 *      A guard that cannot fail is worse than no guard (the audit's own
 *      conclusion about the jsdom cost gate AUDIT-15 built and removed).
 */

/** The pre-index implementation of the audibility rule — the oracle. */
function referenceAudibility(doc: ProjectDocument) {
  const tracks = doc.tracks;
  const anySolo = tracks.some((t) => t.solo);
  const soloedGroups = new Set(tracks.filter((t) => t.kind === "group" && t.solo).map((t) => t.id));
  const groupsWithSoloedChild = new Set<string>();
  for (const t of tracks) {
    if (t.kind !== "group" && t.solo && t.groupId) groupsWithSoloedChild.add(t.groupId);
  }
  return {
    anySolo,
    audible(trackId: string): boolean {
      const t = tracks.find((x) => x.id === trackId);
      if (!t) return false;
      if (t.kind !== "group" && t.groupId) {
        const g = tracks.find((x) => x.id === t.groupId);
        if (g && g.mute) return false;
      }
      if (t.kind === "group") {
        return !t.mute && (!anySolo || t.solo || groupsWithSoloedChild.has(t.id));
      }
      return !t.mute && (!anySolo || t.solo || (t.groupId != null && soloedGroups.has(t.groupId)));
    },
  };
}

function drumTrack(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    kind: "drum",
    name: id,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    pads: [],
    effects: [],
    sends: {},
    ...over,
  } as Track;
}

function groupTrack(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    kind: "group",
    name: id,
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    sends: {},
    ...over,
  } as Track;
}

/**
 * A document whose tracks exercise every branch of the audibility rule:
 * muted groups, soloed groups, muted members, soloed members, plain tracks
 * and members of a soloed group.
 */
function docWithTracks(count: number): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const groupCount = Math.max(1, Math.floor(count / 8));
  const groups: Track[] = [];
  for (let g = 0; g < groupCount; g++) {
    groups.push(groupTrack(`grp-${g}`, { mute: g % 5 === 3, solo: g % 7 === 2 }));
  }
  const tracks: Track[] = [];
  for (let i = 0; i < count; i++) {
    const g = Math.floor(i / 8) % groupCount;
    tracks.push(
      drumTrack(`t-${i}`, {
        groupId: `grp-${g}`,
        mute: i % 11 === 4,
        solo: i % 13 === 5,
      }),
    );
  }
  return { ...base, tracks: [...groups, ...tracks] };
}

/** Count the calls a list makes to `find` — the scan the index replaces. */
function spyOnFind(tracks: Track[]): { count: () => number; restore: () => void } {
  const original = tracks.find;
  let count = 0;
  const spy = function (this: unknown, ...args: unknown[]) {
    count++;
    return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
  };
  Object.defineProperty(tracks, "find", { value: spy, configurable: true, writable: true });
  return {
    count: () => count,
    restore: () => {
      delete (tracks as unknown as { find?: unknown }).find;
    },
  };
}

describe("the shared document index", () => {
  it("gives the same document version the same index", () => {
    const doc = docWithTracks(16);
    expect(getDocIndex(doc)).toBe(getDocIndex(doc));
  });

  it("gives a new document version a new index", () => {
    const doc = docWithTracks(16);
    const before = getDocIndex(doc);
    const next = { ...doc, tracks: [...doc.tracks, drumTrack("t-new")] };
    expect(getDocIndex(next)).not.toBe(before);
    expect(getDocIndex(next).tracksById.has("t-new")).toBe(true);
  });

  it("rebuilds when the track list is replaced in place", () => {
    const doc = docWithTracks(8);
    const before = getDocIndex(doc);
    expect(before.tracksById.has("t-0")).toBe(true);
    // The template factories assign `doc.tracks = [...]`; the index has to
    // notice that, because a WeakMap keyed by the document cannot.
    doc.tracks = [drumTrack("only")];
    const after = getDocIndex(doc);
    expect(after).not.toBe(before);
    expect(after.tracksById.has("only")).toBe(true);
    expect(after.tracksById.has("t-0")).toBe(false);
  });

  it("keeps the FIRST match, exactly like the scan it replaces", () => {
    const doc = docWithTracks(4);
    const first = drumTrack("dup", { name: "first" });
    const second = drumTrack("dup", { name: "second" });
    const withDuplicate = { ...doc, tracks: [...doc.tracks, first, second] };
    expect(getDocIndex(withDuplicate).tracksById.get("dup")).toBe(first);
    expect(withDuplicate.tracks.find((t) => t.id === "dup")).toBe(first);
  });
});

describe("the audibility rule answers exactly like the scan it replaced", () => {
  for (const count of [16, 64, 256]) {
    it(`agrees with the reference rule at ${count} tracks`, () => {
      const doc = docWithTracks(count);
      const rule = soloAudibility(doc);
      const reference = referenceAudibility(doc);
      expect(rule.anySolo).toBe(reference.anySolo);
      for (const track of doc.tracks) {
        expect(rule.audible(track.id), `track ${track.id} must answer the same`).toBe(reference.audible(track.id));
      }
      // An id that is not in the document must stay silent, not throw.
      expect(rule.audible("no-such-track")).toBe(false);
      expect(reference.audible("no-such-track")).toBe(false);
    });
  }
});

describe("the audibility rule no longer scans the track list", () => {
  it("performs zero list scans, and the spy can see a scan when one happens", () => {
    const doc = docWithTracks(64);
    const spy = spyOnFind(doc.tracks);

    const rule = soloAudibility(doc);
    for (const track of doc.tracks) rule.audible(track.id);
    // The group branch of the rule resolves the group id too — it must be a
    // map lookup as well, not a second scan.
    for (const track of doc.tracks) {
      const groupId = "groupId" in track ? track.groupId : undefined;
      if (groupId) rule.audible(groupId);
    }

    expect(spy.count(), "the audibility rule must not scan the track list").toBe(0);

    // POSITIVE CONTROL — without this, the assertion above could pass simply
    // because the spy was never wired to anything.
    const reference = referenceAudibility(doc);
    reference.audible(doc.tracks[0].id);
    expect(spy.count(), "the spy must see the scan the reference rule still makes").toBeGreaterThan(0);

    spy.restore();
  });
});

describe("targetOwner resolves through the index", () => {
  it("finds a track, a return bus and the master", () => {
    const base = createProjectFromTemplate("house");
    const track = drumTrack("t-1");
    const ret = { id: "ret-1", kind: "return" as const, name: "Return", gain: 1, effects: [] };
    const doc: ProjectDocument = { ...base, tracks: [track], returns: [ret] };
    expect(targetOwner(doc, "t-1")).toBe(track);
    expect(targetOwner(doc, "ret-1")).toBe(ret);
    expect(targetOwner(doc, MASTER_EFFECT_OWNER_ID)?.kind).toBe("master");
    expect(targetOwner(doc, "no-such-target")).toBeUndefined();
  });

  it("prefers a track over a return bus with the same id", () => {
    const base = createProjectFromTemplate("house");
    const track = drumTrack("same-id");
    const ret = { id: "same-id", kind: "return" as const, name: "Return", gain: 1, effects: [] };
    const doc: ProjectDocument = { ...base, tracks: [track], returns: [ret] };
    expect(targetOwner(doc, "same-id")).toBe(track);
  });
});
