import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import { STEP_TICKS, type NoteEvent } from "../../src/project-model/types";
import type { Services } from "../../src/services";

function renderEventEditor(note: NoteEvent, instrument: "808" | "acid" | "keys" = "808", selected = false) {
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
      selectedNote={selected ? { trackId: track.id, noteIds: [note.id] } : null}
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

  it("Alt+Shift+S marks an 808 slide note without leaving portamento enabled", () => {
    const { store, track } = renderEventEditor(
      { id: "event-slide-note", pitch: 36, start: 0, duration: STEP_TICKS, velocity: 0.8, slide: true },
      "808",
      true,
    );

    fireEvent.keyDown(window, { key: "s", altKey: true, shiftKey: true });

    expect(noteById(store, track.id)).toMatchObject({ slideNote: true });
    expect(noteById(store, track.id).slide).toBeUndefined();
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).slide).toBe(true);
  });

  it("Alt+Shift+S marks an Acid 303 slide note", () => {
    const { store, track } = renderEventEditor(
      { id: "event-acid-slide-note", pitch: 45, start: 0, duration: STEP_TICKS * 2, velocity: 0.8 },
      "acid",
      true,
    );

    fireEvent.keyDown(window, { key: "s", altKey: true, shiftKey: true });

    expect(noteById(store, track.id)).toMatchObject({ slideNote: true });
    expect(store.undoStackLength).toBe(1);
  });

  it("NEGATIVE: unsupported instruments ignore the slide-note shortcut", () => {
    const { store, track } = renderEventEditor(
      { id: "event-unsupported-slide-note", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.8 },
      "keys",
      true,
    );

    fireEvent.keyDown(window, { key: "s", altKey: true, shiftKey: true });

    expect(noteById(store, track.id).slideNote).toBeUndefined();
    expect(store.undoStackLength).toBe(0);
  });

  it("lets every instrument edit fine pitch and exposes voice-supported event targets", () => {
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
    expect(keysOptions).toEqual([
      "velocity",
      "pitchOffsetSemitones",
      "pan",
      "filterCutoffHz",
      "filterResonance",
      "releaseVelocity",
      "modX",
      "modY",
    ]);
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
      "modX",
      "modY",
    ]);
  });

  it("edits per-note pan on a polyphonic synth through the lane and undo stack", () => {
    const { store, track, target, container } = renderEventEditor(
      { id: "event-keys-pan", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.8 },
      "keys",
    );
    fireEvent.change(target, { target: { value: "pan" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-keys-pan"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 9 });
    fireEvent.pointerMove(bar, { clientY: 90, pointerId: 9 });
    fireEvent.pointerUp(bar, { clientY: 90, pointerId: 9 });

    expect(noteById(store, track.id).expression?.pan).toBe(0.5);
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).expression?.pan).toBeUndefined();
  });

  it("edits direct per-note filter resonance on a non-808 instrument and undoes it", () => {
    const { store, track, target, container } = renderEventEditor(
      {
        id: "event-keys-filter-resonance",
        pitch: 60,
        start: 0,
        duration: STEP_TICKS,
        velocity: 0.8,
        expression: { filterResonance: 0.5 },
      },
      "keys",
    );
    fireEvent.change(target, { target: { value: "filterResonance" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-keys-filter-resonance"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 13 });
    fireEvent.pointerMove(bar, { clientY: 60, pointerId: 13 });
    fireEvent.pointerUp(bar, { clientY: 60, pointerId: 13 });

    expect(noteById(store, track.id).expression?.filterResonance).toBe(1);
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).expression?.filterResonance).toBe(0.5);
  });

  it("edits per-note release velocity on a non-808 instrument and undoes it", () => {
    const { store, track, target, container } = renderEventEditor(
      {
        id: "event-keys-release-velocity",
        pitch: 60,
        start: 0,
        duration: STEP_TICKS,
        velocity: 0.8,
      },
      "keys",
    );
    fireEvent.change(target, { target: { value: "releaseVelocity" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-keys-release-velocity"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 14 });
    fireEvent.pointerMove(bar, { clientY: 60, pointerId: 14 });
    fireEvent.pointerUp(bar, { clientY: 60, pointerId: 14 });

    expect(noteById(store, track.id).expression?.releaseVelocity).toBe(1);
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).expression?.releaseVelocity).toBeUndefined();
  });

  it("edits Mod X on a non-808 filtered instrument through the lane and undo stack", () => {
    const { store, track, target, container } = renderEventEditor(
      {
        id: "event-keys-mod-x",
        pitch: 60,
        start: 0,
        duration: STEP_TICKS,
        velocity: 0.8,
      },
      "keys",
    );
    fireEvent.change(target, { target: { value: "modX" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-keys-mod-x"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 12 });
    fireEvent.pointerMove(bar, { clientY: 60, pointerId: 12 });
    fireEvent.pointerUp(bar, { clientY: 60, pointerId: 12 });

    expect(noteById(store, track.id).expression?.modX).toBe(1);
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).expression?.modX).toBeUndefined();
  });

  it("edits Mod X from the real event lane and records one undoable value", () => {
    const { store, track, target, container } = renderEventEditor({
      id: "event-mod-x",
      pitch: 36,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });
    fireEvent.change(target, { target: { value: "modX" } });
    const bar = container.querySelector<HTMLElement>('[data-expression="event-mod-x"]')!;

    fireEvent.pointerDown(bar, { button: 0, clientY: 120, pointerId: 8 });
    fireEvent.pointerMove(bar, { clientY: 60, pointerId: 8 });
    fireEvent.pointerUp(bar, { clientY: 60, pointerId: 8 });

    expect(noteById(store, track.id).expression?.modX).toBe(1);
    expect(store.undoStackLength).toBe(1);
    act(() => store.undo());
    expect(noteById(store, track.id).expression?.modX).toBeUndefined();
  });
});
