import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ContextMenu } from "../../src/ui/ContextMenu";
import { SelectionContext } from "../../src/ui/context";
import { SelectionStore } from "../../src/store/SelectionStore";
import { mockServices, renderWithContext } from "../helpers";

describe("ContextMenu", () => {
  it("deletes selected arrangement and audio clips as one undoable command", () => {
    const initialServices = mockServices();
    const base = initialServices.store.doc;
    const scene = base.scenes[0];
    const arrangementClip = { id: "menu-arrangement", sceneId: scene.id, startBar: 0, lengthBars: 1 };
    const audioClip = {
      id: "menu-audio",
      trackId: base.tracks.find((track) => track.kind !== "group")!.id,
      bufferId: "user.menu-audio",
      startBar: 0,
      lengthBars: 1,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    };
    const project = {
      ...base,
      arrangement: {
        ...base.arrangement,
        clips: [...base.arrangement.clips, arrangementClip],
        audioClips: [...(base.arrangement.audioClips ?? []), audioClip],
      },
    };
    const services = mockServices(project);
    const selection = new SelectionStore();
    selection.setClips([arrangementClip.id, audioClip.id]);
    const rendered = renderWithContext(
      <SelectionContext.Provider value={selection}>
        <ContextMenu state={{ x: 0, y: 0, context: "2 clips" }} onClose={() => {}} />
      </SelectionContext.Provider>,
      { services },
    );

    screen.getByRole("menuitem", { name: "Delete" }).click();
    const command = (services.store.execute as any).mock.calls.at(-1)?.[0];
    expect(command).toBeDefined();
    const deleted = command.execute(project);
    expect(deleted.arrangement.clips).not.toContainEqual(arrangementClip);
    expect(deleted.arrangement.audioClips).not.toContain(audioClip);
    // One gesture = one undo entry: a single undo returns BOTH clip kinds.
    expect(command.undo(deleted)).toEqual(project);
    rendered.unmount();
  });

  it("delete with stale clip ids executes nothing", () => {
    const services = mockServices();
    const selection = new SelectionStore();
    selection.setClips(["ghost-clip"]);
    const rendered = renderWithContext(
      <SelectionContext.Provider value={selection}>
        <ContextMenu state={{ x: 0, y: 0, context: "1 clips" }} onClose={() => {}} />
      </SelectionContext.Provider>,
      { services },
    );

    screen.getByRole("menuitem", { name: "Delete" }).click();
    expect((services.store.execute as any).mock.calls).toHaveLength(0);
    rendered.unmount();
  });

  it("does not render actions that have no global implementation", () => {
    renderWithContext(<ContextMenu state={{ x: 0, y: 0, context: "Canvas" }} onClose={() => {}} />);
    expect(screen.queryByRole("menuitem", { name: "Paste" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Slice to pads" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Reverse" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Normalize" })).toBeNull();
  });
});
