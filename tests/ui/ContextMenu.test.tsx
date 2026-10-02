import { describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ContextMenu } from "../../src/ui/ContextMenu";
import { SelectionContext } from "../../src/ui/context";
import { SelectionStore } from "../../src/store/SelectionStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { BAR_TICKS } from "../../src/project-model/types";
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

  it("previews and duplicates the exact selected bar range as one undo step", () => {
    const sourceProject = createProjectFromTemplate("scene-score");
    const clip = [...sourceProject.arrangement.clips].sort((a, b) => a.startBar - b.startBar)[0]!;
    const audioClip = {
      id: "range-audio-inside",
      trackId: sourceProject.tracks.find((track) => track.kind !== "group")!.id,
      bufferId: "user.range-audio-inside",
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
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
      ...sourceProject,
      arrangement: { ...sourceProject.arrangement, audioClips: [audioClip] },
    };
    const range = {
      fromTick: clip.startBar * BAR_TICKS,
      toTick: (clip.startBar + clip.lengthBars) * BAR_TICKS,
    };
    const services = mockServices(project);
    const selection = new SelectionStore();
    selection.setTimeRange(range);
    renderWithContext(
      <SelectionContext.Provider value={selection}>
        <ContextMenu state={{ x: 0, y: 0, context: "selected bars" }} onClose={() => {}} />
      </SelectionContext.Provider>,
      { services },
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Producer edit selected range…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Producer range instruction" }), {
      target: { value: "duplicate this range" },
    });
    expect(screen.getByRole("region", { name: "Selected range edit preview" })).toHaveTextContent(
      `Duplicate bars ${clip.startBar + 1}–${clip.startBar + clip.lengthBars}`,
    );
    expect(screen.getByRole("region", { name: "Selected range edit preview" })).toHaveTextContent(
      /including musical and audio clips/i,
    );
    expect(screen.getByText("PREVIEW · MUSICAL + AUDIO")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "DUPLICATE · ONE UNDO STEP" }));

    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("duplicateTimeRange");
    const changed = command!.execute(project);
    expect(changed.arrangement.clips).toHaveLength(project.arrangement.clips.length + 1);
    expect(changed.arrangement.audioClips).toHaveLength(2);
    expect(changed.arrangement.audioClips!.find((candidate) => candidate.id === audioClip.id)).toEqual(audioClip);
    expect(changed.arrangement.audioClips!.find((candidate) => candidate.id !== audioClip.id)?.startBar).toBe(
      audioClip.startBar + clip.lengthBars,
    );
    expect(command!.undo(changed)).toEqual(project);
  });

  it("blocks a range edit when the time selection changes before apply", () => {
    const project = createProjectFromTemplate("scene-score");
    const clip = [...project.arrangement.clips].sort((a, b) => a.startBar - b.startBar)[0]!;
    const range = {
      fromTick: clip.startBar * BAR_TICKS,
      toTick: (clip.startBar + clip.lengthBars) * BAR_TICKS,
    };
    const services = mockServices(project);
    const selection = new SelectionStore();
    selection.setTimeRange(range);
    renderWithContext(
      <SelectionContext.Provider value={selection}>
        <ContextMenu state={{ x: 0, y: 0, context: "selected bars" }} onClose={() => {}} />
      </SelectionContext.Provider>,
      { services },
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Producer edit selected range…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Producer range instruction" }), {
      target: { value: "duplicate selected range" },
    });
    act(() => selection.setTimeRange({ fromTick: range.fromTick + BAR_TICKS, toTick: range.toTick + BAR_TICKS }));

    expect(screen.getByRole("alert")).toHaveTextContent(/time selection changed/i);
    expect(screen.getByRole("button", { name: "APPLY · ONE UNDO STEP" })).toBeDisabled();
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
