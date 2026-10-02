import { describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ContextMenu } from "../../src/ui/ContextMenu";
import { SelectionContext } from "../../src/ui/context";
import { SelectionStore } from "../../src/store/SelectionStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
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

    expect(screen.getByRole("menuitem", { name: "Producer edit selected clip…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
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

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect((services.store.execute as any).mock.calls).toHaveLength(0);
    rendered.unmount();
  });

  it("previews a selection-locked clip edit and applies it as one undo step", () => {
    const project = createProjectFromTemplate("scene-score");
    const selected = [...project.arrangement.clips].sort((a, b) => a.startBar - b.startBar)[1]!;
    const services = mockServices(project);
    const selection = new SelectionStore();
    selection.setClips([selected.id]);
    const onClose = vi.fn();
    renderWithContext(
      <SelectionContext.Provider value={selection}>
        <ContextMenu state={{ x: 0, y: 0, context: "1 clip" }} onClose={onClose} />
      </SelectionContext.Provider>,
      { services },
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Producer edit selected clip…" }));
    expect(screen.getByRole("dialog", { name: "Edit selected clip with Producer" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Producer clip instruction" }), {
      target: { value: "move the selected clip to bar 32" },
    });
    expect(screen.getByRole("region", { name: "Selected clip edit preview" })).toHaveTextContent(
      `Move from bar ${selected.startBar + 1} to bar 32`,
    );

    fireEvent.click(screen.getByRole("button", { name: "APPLY · ONE UNDO STEP" }));
    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("clipWords");
    const changed = command!.execute(project);
    expect(changed.arrangement.clips.find((clip) => clip.id === selected.id)?.startBar).toBe(31);
    expect(command!.undo(changed)).toEqual(project);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refuses to apply if the user changes selection while the clip editor is open", () => {
    const project = createProjectFromTemplate("scene-score");
    const clips = [...project.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
    const selected = clips[1]!;
    const other = clips[0]!;
    const services = mockServices(project);
    const selection = new SelectionStore();
    selection.setClips([selected.id]);
    renderWithContext(
      <SelectionContext.Provider value={selection}>
        <ContextMenu state={{ x: 0, y: 0, context: "1 clip" }} onClose={() => {}} />
      </SelectionContext.Provider>,
      { services },
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Producer edit selected clip…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Producer clip instruction" }), {
      target: { value: "move the selected clip to bar 32" },
    });
    act(() => selection.setClips([other.id]));

    expect(
      screen.getByText(`Target locked · bar ${selected.startBar + 1} · ${selected.lengthBars} bars`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "APPLY · ONE UNDO STEP" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/selected clip changed/i);
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("does not render actions that have no global implementation", () => {
    renderWithContext(<ContextMenu state={{ x: 0, y: 0, context: "Canvas" }} onClose={() => {}} />);
    expect(screen.queryByRole("menuitem", { name: "Paste" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Slice to pads" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Reverse" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Normalize" })).toBeNull();
  });
});
