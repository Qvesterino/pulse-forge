import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MidiPanel } from "../../src/ui/MidiPanel";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { mockServices, renderWithContext } from "../helpers";

function projectWithNotes() {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((value) => value.kind === "instrument")!;
  return {
    ...base,
    key: "C Major" as const,
    patterns: base.patterns.map((pattern) =>
      pattern.id === base.activePatternId
        ? {
            ...pattern,
            notes: {
              ...pattern.notes,
              [track.id]: [
                { id: "ui-a", pitch: 60, start: 0, duration: 120, velocity: 0.8 },
                { id: "ui-b", pitch: 64, start: 240, duration: 120, velocity: 0.8 },
              ],
            },
          }
        : pattern,
    ),
  };
}

describe("MIDI creativity UI", () => {
  it("opens the creativity tab and applies a chord command", () => {
    const doc = projectWithNotes();
    const track = doc.tracks.find((value) => value.kind === "instrument")!;
    const services = mockServices(doc);
    renderWithContext(
      <MidiPanel
        selectedTrackId={track.id}
        selectedNote={null}
        scaleSnap={false}
        onToggleScaleSnap={vi.fn()}
        onClearSelection={vi.fn()}
      />,
      { services },
    );
    fireEvent.click(screen.getByRole("tab", { name: "CREATIVITY" }));
    expect(screen.getByLabelText("MIDI creativity tools")).toBeTruthy();
    expect(screen.getByText("2 notes targeted")).toBeTruthy();
    const apply = screen.getByRole("button", { name: "APPLY CHORD" });
    expect(apply).not.toBeDisabled();
    fireEvent.click(apply);
    expect(services.store.execute).toHaveBeenCalledTimes(1);
  });

  it("multi-selects piano roll notes with Shift-click", () => {
    const doc = projectWithNotes();
    const track = doc.tracks.find((value) => value.kind === "instrument")!;
    const onSelectNote = vi.fn();
    const { container } = renderWithContext(
      <PianoRollTrack
        track={track}
        pattern={doc.patterns.find((value) => value.id === doc.activePatternId)!}
        playheadStep={-1}
        selectedNote={{ trackId: track.id, noteIds: ["ui-a"] }}
        onSelectNote={onSelectNote}
        scaleSnap={false}
      />,
    );
    const notes = Array.from(container.querySelectorAll<HTMLElement>(".pr-note"));
    expect(notes).toHaveLength(2);
    fireEvent.pointerDown(notes[1], { button: 0, shiftKey: true, clientX: 20, clientY: 10 });
    expect(onSelectNote).toHaveBeenLastCalledWith({ trackId: track.id, noteIds: ["ui-a", "ui-b"] });
  });

  it("exposes phase-two generators and applies them through the command store", () => {
    const doc = projectWithNotes();
    const track = doc.tracks.find((value) => value.kind === "instrument")!;
    const services = mockServices(doc);
    renderWithContext(
      <MidiPanel
        selectedTrackId={track.id}
        selectedNote={null}
        scaleSnap={false}
        onToggleScaleSnap={vi.fn()}
        onClearSelection={vi.fn()}
      />,
      { services },
    );
    fireEvent.click(screen.getByRole("tab", { name: "CREATIVITY" }));
    expect(screen.getByLabelText("Arpeggiator mode")).toBeTruthy();
    expect(screen.getByRole("button", { name: "APPLY ARP" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "APPLY NOTE REPEAT" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "APPLY EUCLIDEAN" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "APPLY BASSLINE" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "APPLY ARP" }));
    fireEvent.click(screen.getByRole("button", { name: "APPLY NOTE REPEAT" }));
    fireEvent.click(screen.getByRole("button", { name: "APPLY EUCLIDEAN" }));
    fireEvent.click(screen.getByRole("button", { name: "APPLY BASSLINE" }));
    expect(services.store.execute).toHaveBeenCalledTimes(4);
  });
});
