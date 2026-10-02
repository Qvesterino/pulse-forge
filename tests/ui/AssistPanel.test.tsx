import { describe, expect, it, vi } from "vitest";
import { screen, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistPanel } from "../../src/ui/AssistPanel";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { SelectionStore } from "../../src/store/SelectionStore";
import { getActivePattern, getDrumTrack } from "../../src/project-model/types";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";

describe("AssistPanel", () => {
  it("renders a deterministic preview selector and grid", async () => {
    const user = userEvent.setup();
    renderWithContext(<AssistPanel onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Pattern assist" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "vary pattern preview" })).toBeInTheDocument();
    await user.selectOptions(screen.getAllByRole("combobox")[0], "build");
    expect(screen.getByRole("img", { name: "build pattern preview" })).toBeInTheDocument();
  });

  it("applies through the command store", async () => {
    const user = userEvent.setup();
    const { services } = renderWithContext(<AssistPanel onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "VARY PATTERN" }));
    expect(services.store.execute).toHaveBeenCalledTimes(1);
  });

  it("previews and applies a one-undo variation scoped to the selected drum cells", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const pattern = getActivePattern(doc);
    const drum = getDrumTrack(doc);
    const kick = drum.pads.find((pad) => /kick/i.test(pad.name))!;
    const selection = new SelectionStore();
    selection.setStepSelection({ padIds: [kick.id], from: 0, to: 3 });
    const services = mockServices(doc);
    render(
      <ServicesContext.Provider value={services}>
        <SelectionContext.Provider value={selection}>
          <AssistPanel onClose={() => {}} />
        </SelectionContext.Provider>
      </ServicesContext.Provider>,
    );

    expect(screen.getByRole("img", { name: "vary selected steps preview" })).toBeInTheDocument();
    expect(document.querySelectorAll(".assist-preview-cell.selected")).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "VARY SELECTED STEPS" }));

    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("assistVarySelection");
    const changed = command!.execute(doc);
    const changedPattern = changed.patterns.find((candidate) => candidate.id === pattern.id)!;
    expect(command!.undo(changed)).toEqual(doc);
    for (const pad of drum.pads) {
      for (let step = 4; step < pattern.stepCount; step++) {
        expect(changedPattern.rows[pad.id]?.[step]).toBe(pattern.rows[pad.id]?.[step]);
      }
    }
  });

  it("previews and applies a one-undo humanization scoped to selected notes", async () => {
    const user = userEvent.setup();
    const doc = createProjectFromTemplate("house");
    const basePattern = getActivePattern(doc);
    const targetTrack = doc.tracks.find((track) => track.kind !== "group")!;
    const otherTrack = doc.tracks.find((track) => track.id !== targetTrack.id)!;
    const selectedNote = { id: "assist-selected-note", pitch: 60, start: 480, duration: 180, velocity: 0.72 };
    const untouchedNote = { id: "assist-untouched-note", pitch: 64, start: 720, duration: 120, velocity: 0.6 };
    const otherTrackNote = { id: "assist-other-track-note", pitch: 48, start: 240, duration: 240, velocity: 0.8 };
    const pattern = {
      ...basePattern,
      notes: {
        ...basePattern.notes,
        [targetTrack.id]: [selectedNote, untouchedNote],
        [otherTrack.id]: [otherTrackNote],
      },
    };
    const project = {
      ...doc,
      patterns: doc.patterns.map((candidate) => (candidate.id === pattern.id ? pattern : candidate)),
    };
    const selection = new SelectionStore();
    selection.setNotes({ trackId: targetTrack.id, noteIds: [selectedNote.id] });
    const services = mockServices(project);
    render(
      <ServicesContext.Provider value={services}>
        <SelectionContext.Provider value={selection}>
          <AssistPanel onClose={() => {}} />
        </SelectionContext.Provider>
      </ServicesContext.Provider>,
    );

    expect(screen.getByRole("list", { name: "Selected note changes preview" })).toHaveTextContent("MIDI 60");
    expect(screen.getByText(/timing ±6 ticks · velocity ±7%/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "VARY SELECTED NOTES" }));

    const command = vi.mocked(services.store.execute).mock.calls[0]?.[0];
    expect(command?.type).toBe("assistVaryNoteSelection");
    const changed = command!.execute(project);
    const changedPattern = changed.patterns.find((candidate) => candidate.id === pattern.id)!;
    expect(command!.undo(changed)).toEqual(project);
    expect(changedPattern.notes[targetTrack.id]![0]).toMatchObject({
      id: selectedNote.id,
      pitch: selectedNote.pitch,
      duration: selectedNote.duration,
    });
    expect(changedPattern.notes[targetTrack.id]![1]).toEqual(untouchedNote);
    expect(changedPattern.notes[otherTrack.id]).toEqual([otherTrackNote]);
  });

  it("refuses a stale selection that falls beyond the current pattern length", () => {
    const doc = createProjectFromTemplate("house");
    const pattern = getActivePattern(doc);
    const drum = getDrumTrack(doc);
    const kick = drum.pads.find((pad) => /kick/i.test(pad.name))!;
    const selection = new SelectionStore();
    selection.setStepSelection({
      padIds: [kick.id],
      from: pattern.stepCount,
      to: pattern.stepCount + 3,
    });
    const services = mockServices(doc);
    render(
      <ServicesContext.Provider value={services}>
        <SelectionContext.Provider value={selection}>
          <AssistPanel onClose={() => {}} />
        </SelectionContext.Provider>
      </ServicesContext.Provider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/no longer matches this pattern/i);
    expect(screen.queryByRole("button", { name: "VARY SELECTED STEPS" })).toBeNull();
  });
});
