import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { moveTrackAdjacent, moveTrackBySteps } from "../../src/commands/tracks";

describe("moveTrackBySteps (keyboard/palette reorder)", () => {
  it("moves a track up by swapping with its predecessor", () => {
    const doc = createProjectFromTemplate("house");
    const order = doc.tracks.map((track) => track.id);
    const command = moveTrackBySteps(doc, order[1]!, -1);
    expect(command).not.toBeNull();
    const moved = command!.execute(doc);
    expect(moved.tracks.map((track) => track.id)).toEqual([order[1], order[0], ...order.slice(2)]);
  });

  it("moves a track down by swapping with its successor", () => {
    const doc = createProjectFromTemplate("house");
    const order = doc.tracks.map((track) => track.id);
    const command = moveTrackBySteps(doc, order[0]!, 1);
    expect(command).not.toBeNull();
    const moved = command!.execute(doc);
    expect(moved.tracks.map((track) => track.id)).toEqual([order[1], order[0], ...order.slice(2)]);
  });

  it("is a no-op at the top of the stack (no command, no junk undo)", () => {
    const doc = createProjectFromTemplate("house");
    const first = doc.tracks[0]!;
    expect(moveTrackBySteps(doc, first.id, -1)).toBeNull();
  });

  it("is a no-op at the bottom of the stack", () => {
    const doc = createProjectFromTemplate("house");
    const last = doc.tracks[doc.tracks.length - 1]!;
    expect(moveTrackBySteps(doc, last.id, 1)).toBeNull();
  });

  it("returns null for an unknown track instead of throwing", () => {
    const doc = createProjectFromTemplate("house");
    expect(moveTrackBySteps(doc, "track-does-not-exist", -1)).toBeNull();
  });

  it("matches moveTrackAdjacent output for the same swap", () => {
    const doc = createProjectFromTemplate("house");
    const order = doc.tracks.map((track) => track.id);
    const bySteps = moveTrackBySteps(doc, order[1]!, -1)!.execute(doc);
    const byAdjacent = moveTrackAdjacent(doc, order[1]!, order[0]!, "before").execute(doc);
    expect(bySteps.tracks.map((track) => track.id)).toEqual(byAdjacent.tracks.map((track) => track.id));
  });
});
