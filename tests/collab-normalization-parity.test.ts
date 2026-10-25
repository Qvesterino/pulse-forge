/**
 * The collab store normalises in GENERAL, not only for the domain that
 * happened to be reported (audit F-16).
 *
 * The solo `ProjectStore` normalises the whole document on every command. The
 * collab store used to re-project local commands WITHOUT `normalizeProject`,
 * so a document that arrived NON-canonical from outside the command layer
 * (project import, share code, a collab peer, a hand-edited file) kept its
 * broken shape in the CRDT — and the user saw a document that was not the
 * document they got when the session ended.
 *
 * `tests/fxeq-collab-normalization.test.ts` pins the FXEQ carrier. This file
 * pins the GENERAL contract on a DIFFERENT domain, with a mechanism the FXEQ
 * test cannot reach: the stale state is already in the CRDT BEFORE any command
 * runs, and it is an ORDINARY command (one that has nothing to do with
 * markers) that must canonicalise it.
 *
 * The carrier is a dangling marker link. The marker normaliser is the sharpest
 * second backstop in the codebase — its own doc calls it "the only backstop
 * for a document that arrived from outside the command layer" — and it CLEARS
 * the reference while keeping the marker ("a cue is navigation, not content").
 */
import { describe, expect, it } from "vitest";
import { YDocStore } from "../src/collab/YDocStore";
import { yDocToProject } from "../src/collab/YDocAdapter";
import { normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { setTrackParams } from "../src/commands/project";
import type { ProjectDocument } from "../src/project-model/types";
import { testDoc } from "./fixtures/doc";

const STALE_MARKER_ID = "marker-stale-link";
const STALE_CLIP_ID = "clip-does-not-exist";

/** A document that is already non-canonical: the marker points at nothing. */
function docWithDanglingMarkerLink(): ProjectDocument {
  const doc = testDoc();
  return {
    ...doc,
    markers: [
      ...(doc.markers ?? []),
      { id: STALE_MARKER_ID, name: "STALE", type: "cue", tick: 480, linkedClipId: STALE_CLIP_ID },
    ],
  };
}

const linkOf = (doc: ProjectDocument): string | undefined =>
  doc.markers?.find((marker) => marker.id === STALE_MARKER_ID)?.linkedClipId;

describe("the collab store normalises in general (F-16)", () => {
  it("starts non-canonical in the CRDT and is canonical after ANY local command", () => {
    const stale = docWithDanglingMarkerLink();
    const trackId = stale.tracks[0].id;

    const solo = new ProjectStore(stale);
    const collab = YDocStore.fromDocument(stale);

    // The CRDT is fed the raw document — `fromDocument` does NOT normalise.
    const rawBefore = yDocToProject(collab.yDocRef.getMap("project"));
    expect(linkOf(rawBefore)).toBe(STALE_CLIP_ID);
    expect(normalizeProject(rawBefore)).not.toEqual(rawBefore);

    // ONE ordinary command — it has nothing to do with markers.
    solo.execute(setTrackParams(solo.getDoc(), trackId, { gain: 0.42 }));
    collab.execute(setTrackParams(collab.getDoc(), trackId, { gain: 0.42 }));

    // The CRDT is canonical now: the dangling link is gone.
    const rawAfter = yDocToProject(collab.yDocRef.getMap("project"));
    expect(linkOf(rawAfter)).toBeUndefined();
    expect(normalizeProject(rawAfter)).toEqual(rawAfter);

    // The marker itself survives — only the reference is cleared.
    expect(rawAfter.markers?.some((marker) => marker.id === STALE_MARKER_ID)).toBe(true);

    // And the collab document is the solo document.
    expect(collab.getDoc()).toEqual(solo.getDoc());
  });

  it("the document the user sees in collab IS the document the session ends with", () => {
    const stale = docWithDanglingMarkerLink();
    const trackId = stale.tracks[0].id;
    const collab = YDocStore.fromDocument(stale);

    collab.execute(setTrackParams(collab.getDoc(), trackId, { gain: 0.42 }));

    // Leaving the session normalises the document — if it already IS
    // normalised, leaving changes nothing. That is the whole point.
    const seen = collab.getDoc();
    expect(normalizeProject(seen)).toEqual(seen);
    expect(linkOf(seen)).toBeUndefined();
  });
});
