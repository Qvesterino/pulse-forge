import { describe, expect, it } from "vitest";
import { SelectionStore } from "../src/store/SelectionStore";

/**
 * The selection is UI state, and document commands are pure
 * `ProjectDocument → Command` — so neither can see the other. A destructive
 * track action therefore has to drop the track from the selection at its own
 * call site, or the selection keeps naming an object that no longer exists.
 * These are the two entry points that delete tracks.
 */
describe("SelectionStore — dead track references", () => {
  describe("pruneTrack (mixer delete button)", () => {
    it("removes the id and the track's note selection, keeping everything else", () => {
      const store = new SelectionStore();
      store.setTracks(["a", "b", "c"]);
      store.setNotes({ trackId: "b", noteIds: ["n1"] }, "replace");
      store.setNotes({ trackId: "c", noteIds: ["n2"] }, "add");

      store.pruneTrack("b");

      expect(store.getState().trackIds).toEqual(["a", "c"]);
      // Only b's note selection goes — c's must survive, or a single delete
      // would silently wipe an unrelated multi-track note selection.
      expect(store.getState().noteSelections).toEqual([{ trackId: "c", noteIds: ["n2"] }]);
    });

    it("does not emit when the track was not referenced", () => {
      const store = new SelectionStore();
      store.setTracks(["a"]);
      let emissions = 0;
      store.subscribe(() => emissions++);

      store.pruneTrack("zzz");

      expect(store.getState().trackIds).toEqual(["a"]);
      // The guard matters: emitting on every delete attempt would re-render
      // every selection subscriber for no state change.
      expect(emissions).toBe(0);
    });

    it("leaves a note selection for an unselected track alone", () => {
      const store = new SelectionStore();
      store.setTracks(["a"]);
      // Notes selected without the track ever entering trackIds.
      store.setNotes({ trackId: "z", noteIds: ["n1"] }, "replace");

      store.pruneTrack("a");

      expect(store.getState().trackIds).toEqual([]);
      expect(store.getState().noteSelections).toEqual([{ trackId: "z", noteIds: ["n1"] }]);
    });
  });

  describe("retainTracks (intent engine removeTrack op)", () => {
    it("drops every id not in the live set", () => {
      const store = new SelectionStore();
      store.setTracks(["a", "b", "c"]);

      store.retainTracks(["a", "c"]);

      expect(store.getState().trackIds).toEqual(["a", "c"]);
    });

    it("filters noteSelections against the caller's live set, not against trackIds", () => {
      const store = new SelectionStore();
      store.setTracks(["a"]);
      store.setNotes({ trackId: "a", noteIds: ["n1"] }, "replace");
      store.setNotes({ trackId: "ghost", noteIds: ["n2"] }, "add");

      // "ghost" is not in trackIds but IS a live track here, so it must stay.
      store.retainTracks(["a", "ghost"]);

      expect(store.getState().noteSelections.map((ns) => ns.trackId)).toEqual(["a", "ghost"]);
    });

    it("does not emit when everything is still live", () => {
      const store = new SelectionStore();
      store.setTracks(["a", "b"]);
      let emissions = 0;
      store.subscribe(() => emissions++);

      store.retainTracks(["a", "b", "c"]);

      expect(store.getState().trackIds).toEqual(["a", "b"]);
      expect(emissions).toBe(0);
    });
  });
});
