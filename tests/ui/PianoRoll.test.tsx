import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { STEP_TICKS, type NoteEvent } from "../../src/project-model/types";

const domRect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

function renderRoll(doc = createProjectFromTemplate("house"), note?: NoteEvent) {
  const track = doc.tracks.find((t) => t.kind === "instrument")!;
  const pattern = doc.patterns[0];
  if (note) pattern.notes = { [track.id]: [note] };
  const services = mockServices(doc);
  const utils = renderWithContext(
    <PianoRollTrack
      track={track}
      pattern={pattern}
      playheadStep={-1}
      selectedNote={null}
      onSelectNote={vi.fn()}
      scaleSnap={false}
    />,
    { services },
  );
  return { ...utils, track, pattern };
}

/** Drag a note by `dx` px in move mode (pointer down in the top third). */
function dragNote(noteEl: HTMLElement, gridEl: HTMLElement, dx: number, finish: "up" | "cancel") {
  vi.spyOn(gridEl, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 160, 240));
  // 32px-wide note: pointer 4px in, 2px down = top third → move mode.
  vi.spyOn(noteEl, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 32, 16));
  fireEvent.pointerDown(noteEl, { button: 0, clientX: 4, clientY: 2, pointerId: 1 });
  fireEvent.pointerMove(noteEl, { clientX: 4 + dx, clientY: 2, pointerId: 1 });
  if (finish === "up") fireEvent.pointerUp(noteEl, { pointerId: 1 });
  else fireEvent.pointerCancel(noteEl, { pointerId: 1 });
}

describe("PianoRollTrack", () => {
  it("renders piano roll SVG area", () => {
    const { container } = renderRoll();
    expect(container.querySelector(".pianoroll")).toBeTruthy();
  });

  it("renders with piano roll class", () => {
    const { container } = renderRoll();
    expect(container.querySelector(".pianoroll")).toBeTruthy();
  });

  it("commits a completed note move on pointerup", () => {
    const note: NoteEvent = { id: "n1", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.9 };
    const { container, services } = renderRoll(createProjectFromTemplate("house"), note);
    const noteEl = container.querySelector('.pr-note[data-note-id="n1"]') as HTMLElement;
    const gridEl = container.querySelector(".pianoroll-grid") as HTMLElement;
    dragNote(noteEl, gridEl, 40, "up");
    // Grid is 160px wide, house patterns have 16 steps → 40px = +4 steps.
    expect(services.store.execute).toHaveBeenCalledTimes(1);
  });

  it("aborts a note move on pointercancel without committing", () => {
    const note: NoteEvent = { id: "n1", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.9 };
    const { container, services } = renderRoll(createProjectFromTemplate("house"), note);
    const noteEl = container.querySelector('.pr-note[data-note-id="n1"]') as HTMLElement;
    const gridEl = container.querySelector(".pianoroll-grid") as HTMLElement;
    dragNote(noteEl, gridEl, 40, "cancel");
    expect(services.store.execute).not.toHaveBeenCalled();
  });

  it("a stale pointerup after a cancel does not commit", () => {
    const note: NoteEvent = { id: "n1", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.9 };
    const { container, services } = renderRoll(createProjectFromTemplate("house"), note);
    const noteEl = container.querySelector('.pr-note[data-note-id="n1"]') as HTMLElement;
    const gridEl = container.querySelector(".pianoroll-grid") as HTMLElement;
    dragNote(noteEl, gridEl, 40, "cancel");
    fireEvent.pointerUp(noteEl, { pointerId: 1 });
    expect(services.store.execute).not.toHaveBeenCalled();
  });
});
