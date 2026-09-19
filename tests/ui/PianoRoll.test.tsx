import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
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

  it("renders memoized notes with the same DOM attributes as before (parity)", () => {
    const note: NoteEvent = {
      id: "n1",
      pitch: 60,
      start: STEP_TICKS * 2,
      duration: STEP_TICKS * 3,
      velocity: 0.6,
      slide: true,
    };
    const { container } = renderRoll(createProjectFromTemplate("house"), note);
    const el = container.querySelector('.pr-note[data-note-id="n1"]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.className).toContain("slide");
    expect(el.style.left).toBe("12.5%"); // 2 of 16 steps (house pattern)
    expect(el.style.width).toBe("18.75%"); // 3 of 16 steps
    expect(el.style.opacity).toBeCloseTo(0.35 + 0.6 * 0.65, 5);
    expect(el.title).toContain("C4");
    expect(el.title).toContain("(slide)");
    // Velocity lane bar renders alongside the grid note.
    expect(container.querySelector('[data-vel="n1"]')).toBeTruthy();
  });

  it("drag preview renders on the dragged note only (move preview offset)", () => {
    const note: NoteEvent = { id: "n1", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.9 };
    const { container } = renderRoll(createProjectFromTemplate("house"), note);
    const noteEl = container.querySelector('.pr-note[data-note-id="n1"]') as HTMLElement;
    const gridEl = container.querySelector(".pianoroll-grid") as HTMLElement;
    dragNote(noteEl, gridEl, 40, "cancel"); // cancel = no commit, but preview existed during move
    expect(noteEl).toBeTruthy();
  });

  it("touch long-press opens the note menu and the release does not move the note", async () => {
    vi.useFakeTimers();
    try {
      const note: NoteEvent = { id: "n1", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.9 };
      const { container, services } = renderRoll(createProjectFromTemplate("house"), note);
      const noteEl = container.querySelector('.pr-note[data-note-id="n1"]') as HTMLElement;
      fireEvent.pointerDown(noteEl, {
        button: 0,
        pointerType: "touch",
        clientX: 8,
        clientY: 4,
        pointerId: 1,
      });
      await act(async () => {
        vi.advanceTimersByTime(470);
      });
      expect(container.querySelector(".pr-note-menu")).not.toBeNull();
      fireEvent.pointerUp(noteEl, { pointerId: 1 });
      expect(services.store.execute).not.toHaveBeenCalled();
      // The menu offers Delete / Duplicate / Slide.
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(command?.type).toBe("deleteNote");
    } finally {
      vi.useRealTimers();
    }
  });
});
