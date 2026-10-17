import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import { STEP_TICKS, type NoteEvent } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * PIANO-ROLL RESIZE GESTURE GATE (seam: piano-roll-resize)
 *
 * The seam ledger listed this OPEN — "no spec mentions resize or the right
 * edge; move is covered, resize is not". This is the same shape as the EQ
 * defect: hit-test math can be perfect while the gesture writes the wrong
 * duration (or commits a dead press).
 *
 * Geometry: the roll measures its viewport with a ResizeObserver, which jsdom
 * does not run, so the width falls back to 800 px / 16 steps = 50 px per step
 * (PianoRoll.tsx:428-429). The note element is stubbed 32×16, so the right
 * edge is anything past clientX 24; the grid rect is jsdom's all-zero rect, so
 * `stepF = clientX / 50`.
 */

function renderLiveRoll(note: NoteEvent) {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind === "instrument")!;
  const pattern = doc.patterns[0]!;
  pattern.notes = { [track.id]: [note] };
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
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
  const noteEl = utils.container.querySelector<HTMLElement>(`[data-note-id="${note.id}"]`);
  expect(noteEl, "note element did not render — the probe measured nothing").not.toBeNull();
  vi.spyOn(noteEl!, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 32,
    height: 16,
    right: 32,
    bottom: 16,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return { project, track, noteEl: noteEl! };
}

const noteIn = (project: ProjectStore, trackId: string) => project.getDoc().patterns[0]!.notes?.[trackId] ?? [];

afterEach(() => cleanup());

describe("piano-roll right-edge resize (seam: piano-roll-resize)", () => {
  it("dragging the right edge commits ONE resize to the dropped duration", () => {
    const { project, track, noteEl } = renderLiveRoll({
      id: "n1",
      pitch: 60,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });

    // Right edge = past width-8 px. clientX 28 → stepF 28/50 = 0.56 at press…
    fireEvent.pointerDown(noteEl, { button: 0, clientX: 28, clientY: 8, pointerId: 1 });
    // …then out to clientX 148 → stepF 2.96 → durSteps = round(2.96) = 3.
    fireEvent.pointerMove(noteEl, { clientX: 148, clientY: 8, pointerId: 1 });
    fireEvent.pointerUp(noteEl, { pointerId: 1 });

    const notes = noteIn(project, track.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.duration).toBe(3 * STEP_TICKS);
    expect(notes[0]!.start, "resize must not move the note").toBe(0);
    expect(project.undoStackLength).toBe(1);
  });

  it("NEGATIVE: press + release on the right edge with NO move commits nothing", () => {
    const { project, track, noteEl } = renderLiveRoll({
      id: "n1",
      pitch: 60,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });

    fireEvent.pointerDown(noteEl, { button: 0, clientX: 28, clientY: 8, pointerId: 1 });
    fireEvent.pointerUp(noteEl, { pointerId: 1 });

    expect(noteIn(project, track.id)[0]!.duration).toBe(STEP_TICKS);
    expect(project.undoStackLength).toBe(0);
  });

  it("NEGATIVE: an interrupted resize (pointercancel) commits nothing", () => {
    const { project, track, noteEl } = renderLiveRoll({
      id: "n1",
      pitch: 60,
      start: 0,
      duration: STEP_TICKS,
      velocity: 0.8,
    });

    fireEvent.pointerDown(noteEl, { button: 0, clientX: 28, clientY: 8, pointerId: 1 });
    fireEvent.pointerMove(noteEl, { clientX: 148, clientY: 8, pointerId: 1 });
    fireEvent.pointerCancel(noteEl, { pointerId: 1 });

    expect(noteIn(project, track.id)[0]!.duration).toBe(STEP_TICKS);
    expect(project.undoStackLength).toBe(0);
  });

  it("a resize can never shrink a note below one step (zero duration is unreachable)", () => {
    const { project, track, noteEl } = renderLiveRoll({
      id: "n1",
      pitch: 60,
      start: 2 * STEP_TICKS,
      duration: 2 * STEP_TICKS,
      velocity: 0.8,
    });

    // Drag far left of the note start: stepF 0.08 - 2 = -1.92 → clamped to 1 step.
    fireEvent.pointerDown(noteEl, { button: 0, clientX: 28, clientY: 8, pointerId: 1 });
    fireEvent.pointerMove(noteEl, { clientX: 4, clientY: 8, pointerId: 1 });
    fireEvent.pointerUp(noteEl, { pointerId: 1 });

    const note = noteIn(project, track.id)[0]!;
    expect(note.duration).toBe(STEP_TICKS);
    expect(note.start).toBe(2 * STEP_TICKS);
    expect(project.undoStackLength).toBe(1);
  });
});
