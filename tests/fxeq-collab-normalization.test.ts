import { describe, expect, it } from "vitest";
import { addEffectToTracks } from "../src/commands/tracks";
import { setFxEqParam } from "../src/commands/plugins";
import { yDocToProject } from "../src/collab/YDocAdapter";
import { YDocStore } from "../src/collab/YDocStore";
import { normalizeProject } from "../src/project-model/schema";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";

function projectWithFxeqMix(mix: number) {
  const doc = testDoc();
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument");
  if (!track) throw new Error("fixture: house template has no instrument track");

  const withFxeq = addEffectToTracks(doc, [track.id], "fxeq").execute(doc);
  const effect = withFxeq.tracks.find((candidate) => candidate.id === track.id)!.effects[0]!;
  const withMix = {
    ...withFxeq,
    tracks: withFxeq.tracks.map((candidate) =>
      candidate.id === track.id
        ? {
            ...candidate,
            effects: candidate.effects.map((instance) =>
              instance.id === effect.id ? { ...instance, params: { ...instance.params, mix } } : instance,
            ),
          }
        : candidate,
    ),
  };
  return { doc: normalizeProject(withMix), trackId: track.id, fxId: effect.id };
}

describe("PRISM write-back has solo/collab parity (F-16, F-28)", () => {
  it("normalizes the core write-back in the Y.Doc, matching solo, undo, and reload", () => {
    const { doc: before, trackId, fxId } = projectWithFxeqMix(0.3);
    const solo = new ProjectStore(before);
    const collab = YDocStore.fromDocument(before);

    // PRISM reports its internal id and percentage scale; the command maps
    // globalMix=100 back to the rack's canonical mix=1 before either store.
    solo.execute(setFxEqParam(solo.doc, trackId, fxId, "globalMix", 100));
    collab.execute(setFxEqParam(collab.doc, trackId, fxId, "globalMix", 100));

    const fx = collab.doc.tracks.find((track) => track.id === trackId)!.effects[0]!;
    const soloFx = solo.doc.tracks.find((track) => track.id === trackId)!.effects[0]!;
    // Compare the raw stored parameter map too: normalizing the projection in
    // the test would otherwise hide the very alias drift this guards.
    expect(fx.params).toEqual(soloFx.params);
    expect(fx.params.mix).toBe(1);
    expect(fx.params.globalMix).toBe(1);
    expect(normalizeProject(collab.doc)).toEqual(solo.doc);
    expect(yDocToProject(collab.yDocRef.getMap("project"))).toEqual(collab.doc);

    // Reconstructing a store from the Y.Doc must not normalize into a
    // different audible/project value at the collaboration boundary.
    expect(YDocStore.fromDocument(collab.doc).doc).toEqual(solo.doc);

    collab.undo();
    expect(collab.doc.tracks.find((track) => track.id === trackId)!.effects[0]!.params.mix).toBe(0.3);
    expect(collab.doc.tracks.find((track) => track.id === trackId)!.effects[0]!.params.globalMix).toBe(0.3);
    expect(yDocToProject(collab.yDocRef.getMap("project"))).toEqual(collab.doc);
  });
});
