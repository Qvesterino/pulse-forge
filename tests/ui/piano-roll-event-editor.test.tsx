import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import { STEP_TICKS, type NoteEvent } from "../../src/project-model/types";
import type { Services } from "../../src/services";

function renderEventEditor(note: NoteEvent, instrument: "808" | "keys" = "808") {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((candidate) => candidate.kind === "instrument")!;
  track.instrument = instrument;
  const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId)!;
  pattern.notes = { [track.id]: [note] };
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  const view = renderWithContext(
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
  const target = screen.getByRole("combobox", { name: "Piano roll event target" });
  return { store, track, target, container: view.container };
}

function noteById(store: ProjectStore, trackId: string): NoteEvent {
  return store.doc.patterns.find((pattern) => pattern.id === store.doc.activePatternId)!.notes?.[trackId]?.[0]!;
}

afterEach(() => cleanup());

describe("Piano Roll Event Editor (seam: piano-roll-event-editor)", () => {
  it("edits per-note pan from the real lane and keeps one undoable change", () => {
    const { store, track, target, container } = renderEventEditor({
      id: "event-pan",
      pitch: 36,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });
    fireEvent.change(target, { target: { value: "pan" } });
    expect((target as HTMLSelectElement).value).toBe("pan");
    expect(container.querySelector(".pr-velocity-lane")?.getAttribute("data-event-target")).toBe("pan");
    const bar = container.querySelector<HTMLElement>('[data-expression="event-pan"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 2 });
    fireEvent.pointerMove(bar, { clientY: 60, pointerId: 2 });
    expect(bar.style.height).toBe("50%");
    fireEvent.pointerUp(bar, { clientY: 60, pointerId: 2 });

    expect(noteById(store, track.id).expression?.pan).toBe(1);
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).expression?.pan).toBeUndefined();
  });

  it("NEGATIVE: a press and release without movement writes no expression or undo entry", () => {
    const { store, track, target, container } = renderEventEditor({
      id: "event-no-move",
      pitch: 36,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });
    fireEvent.change(target, { target: { value: "pan" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-no-move"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 3 });
    fireEvent.pointerUp(bar, { clientY: 120, pointerId: 3 });

    expect(noteById(store, track.id).expression?.pan).toBeUndefined();
    expect(store.undoStackLength).toBe(0);
  });

  it("NEGATIVE: pointercancel rolls back the lane preview", () => {
    const { store, track, target, container } = renderEventEditor({
      id: "event-cancel",
      pitch: 36,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });
    fireEvent.change(target, { target: { value: "pan" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-cancel"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 4 });
    fireEvent.pointerMove(bar, { clientY: 20, pointerId: 4 });
    fireEvent.pointerCancel(bar, { pointerId: 4 });

    expect(noteById(store, track.id).expression?.pan).toBeUndefined();
    expect(store.undoStackLength).toBe(0);
    expect(bar.style.height).toBe("0%");
  });

  it("shows the 808 tone as the implicit cutoff and Alt-click restores that default", () => {
    const { store, track, target, container } = renderEventEditor({
      id: "event-cutoff-reset",
      pitch: 36,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
      expression: { filterCutoffHz: 2400 },
    });
    fireEvent.change(target, { target: { value: "filterCutoffHz" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-cutoff-reset"]')!;
    expect(bar.title).toContain("2400 Hz");

    fireEvent.pointerDown(bar, { button: 0, altKey: true, clientY: 120, pointerId: 5 });

    expect(noteById(store, track.id).expression?.filterCutoffHz).toBeUndefined();
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).expression?.filterCutoffHz).toBe(2400);
  });

  it("lets every instrument edit fine pitch while exposing 808-only targets only on 808", () => {
    const keys = renderEventEditor(
      {
        id: "event-pitch",
        pitch: 60,
        start: 0,
        duration: STEP_TICKS,
        velocity: 0.8,
      },
      "keys",
    );
    const keysOptions = Array.from((keys.target as HTMLSelectElement).options).map((option) => option.value);
    expect(keysOptions).toEqual(["velocity", "pitchOffsetSemitones"]);
    cleanup();

    const eightOhEight = renderEventEditor({
      id: "event-808",
      pitch: 36,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });
    const eightOhEightOptions = Array.from((eightOhEight.target as HTMLSelectElement).options).map(
      (option) => option.value,
    );
    expect(eightOhEightOptions).toEqual([
      "velocity",
      "pitchOffsetSemitones",
      "pan",
      "filterCutoffHz",
      "filterResonance",
      "releaseVelocity",
    ]);
  });
});
