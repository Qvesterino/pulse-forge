import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { PianoRollTrack } from "../../src/ui/PianoRoll";
import { useSelection } from "../../src/ui/context";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { deleteArrangementClip, addArrangementClip } from "../../src/commands/commands";
import { addAudioClip } from "../../src/commands/audioClips";
import { ToolContext } from "../../src/ui/context";
import { ToolStore } from "../../src/store/ToolStore";
import { mockServices, renderWithContext } from "../helpers";
import type { Services } from "../../src/services";
import type { NoteEvent, ProjectDocument } from "../../src/project-model/types";
import { STEP_TICKS } from "../../src/project-model/types";
import { usePointerDragGuard } from "../../src/ui/usePointerDragGuard";
import { useEffect } from "react";

/**
 * Editor hardening audit — interaction-level regression coverage. Every
 * behavior pinned here contradicts a removed defect:
 *
 *  - Stale clip selection: deleting through deleteClipsWithToast left dead ids
 *    in SelectionStore.clipIds (only the panel-local mirror was cleared).
 *  - Mid-drag unmount: a captured clip element deleted mid-gesture never
 *    delivers pointerup, so the block move never committed and surviving
 *    clips kept a ghost offset.
 *  - Alt+click duplicate: the duplicate committed at POINTERDOWN, so a press-
 *    release with no movement planted an invisible copy on the original.
 *  - Paste overflow: pasting a clipboard taken from a longer pattern landed
 *    notes past patternTicks — silent zombies only normalizeProject dropped.
 */

function liveServices(doc: ProjectDocument) {
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  return { project, services };
}

const SelectionProbe = () => {
  const selection = useSelection();
  return <div data-testid="clip-selection">{selection.clipIds.join(",")}</div>;
};

function renderLiveArrangement(doc: ProjectDocument) {
  const { project, services } = liveServices(doc);
  const utils = renderWithContext(
    <>
      <ArrangementPanel />
      <SelectionProbe />
    </>,
    { services },
  );
  return { ...utils, project, doc };
}

function twoClipDoc(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  return addArrangementClip(base, base.scenes[0]!.id, 4, 4).execute(base);
}

const clipEls = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".arr-clip"));

describe("stale clip selection after delete (SelectionStore invariant)", () => {
  it("deleteClipsWithToast prunes the deleted id from selectionStore", () => {
    const { project, doc } = renderLiveArrangement(twoClipDoc());
    const clips = doc.arrangement.clips;
    const [first, second] = clips;

    // Build a selection the way the timeline does: ctrl+click toggles ids.
    fireEvent.pointerDown(clipEls()[1]!, { button: 0, ctrlKey: true, pointerId: 1, clientX: 0 });
    expect(screen.getByTestId("clip-selection").textContent).toBe(second!.id);

    // The clip toolbar's DEL deletes the pressed clip through
    // deleteClipsWithToast (context menu / long-press share the path).
    const dup = screen.getByRole("button", { name: "DUP" });
    const del = dup.nextElementSibling as HTMLButtonElement;
    fireEvent.click(del);

    expect(project.getDoc().arrangement.clips.some((c) => c.id === second!.id)).toBe(false);
    // Pre-fix this still held the deleted id — the context-menu header kept
    // counting it and `P` (locators to loop) silently did nothing.
    expect(screen.getByTestId("clip-selection").textContent).toBe("");
    expect(project.getDoc().arrangement.clips.some((c) => c.id === first!.id)).toBe(true);
  });
});

describe("mid-drag unmount (window drag guard)", () => {
  it("an orphaned pointerup still commits the surviving block move", () => {
    const { project } = renderLiveArrangement(twoClipDoc());
    const els = clipEls();
    expect(els.length).toBe(2);

    // Multi-select both clips via ctrl+click…
    fireEvent.pointerDown(els[0]!, { button: 0, ctrlKey: true, pointerId: 1, clientX: 0 });
    fireEvent.pointerDown(els[1]!, { button: 0, ctrlKey: true, pointerId: 1, clientX: 0 });

    // …then press the FIRST clip plainly: a multi-block drag starts
    // (clientX -20 keeps the hit-test in "move", not the resize edge).
    fireEvent.pointerDown(els[0]!, { button: 0, pointerId: 1, clientX: -20 });
    fireEvent.pointerMove(els[0]!, { button: 0, pointerId: 1, clientX: 100 });

    // The second clip is deleted MID-DRAG (undo/collab race): its element
    // unmounts, so its own pointerup can never fire.
    const doc = project.getDoc();
    const secondId = doc.arrangement.clips[1]!.id;
    act(() => {
      project.execute(deleteArrangementClip(doc, secondId));
    });

    // Release the mouse — the event lands on the window.
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });

    // Pre-fix the commit never ran (dragRef pointed at a dead element) and
    // the surviving clip kept its ghost offset. Now the block move commits
    // for the survivors: 3 bars right of its original start.
    const survivor = project.getDoc().arrangement.clips[0]!;
    expect(survivor.startBar).toBe(3);
  });

  it("window pointercancel aborts instead of committing", () => {
    const { project } = renderLiveArrangement(twoClipDoc());
    const els = clipEls();
    fireEvent.pointerDown(els[0]!, { button: 0, pointerId: 1, clientX: -20 });
    fireEvent.pointerMove(els[0]!, { pointerId: 1, clientX: 100 });
    const before = project.getDoc();
    act(() => {
      window.dispatchEvent(new Event("pointercancel"));
    });
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(project.getDoc().arrangement.clips[0]!.startBar).toBe(before.arrangement.clips[0]!.startBar);
    expect(project.getDoc()).toBe(before);
  });
});

function renderLiveRoll(note: NoteEvent) {
  const doc = createProjectFromTemplate("house");
  const track = doc.tracks.find((t) => t.kind === "instrument")!;
  const pattern = doc.patterns[0]!;
  pattern.notes = { [track.id]: [note] };
  const { project, services } = liveServices(doc);
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
  return { ...utils, project, track, pattern };
}

const noteIn = (project: ProjectStore, trackId: string) => project.getDoc().patterns[0]!.notes?.[trackId] ?? [];

describe("alt+click must not plant a hidden duplicate", () => {
  it("press + release without movement creates nothing", () => {
    const note: NoteEvent = { id: "n1", pitch: 60, start: 0, duration: STEP_TICKS, velocity: 0.8 };
    const { project, track, container } = renderLiveRoll(note);
    const noteEl = container.querySelector<HTMLElement>(`[data-note-id="n1"]`);
    expect(noteEl).not.toBeNull();
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

    fireEvent.pointerDown(noteEl!, { button: 0, altKey: true, clientX: 4, clientY: 2, pointerId: 1 });
    fireEvent.pointerUp(noteEl!, { pointerId: 1 });

    // Pre-fix the duplicate committed at pointerdown: two stacked notes.
    expect(noteIn(project, track.id)).toHaveLength(1);
  });

  it("alt+drag materializes exactly one duplicate at the dragged position", () => {
    // Pitch 84 sits on the grid row the stubbed pointer touches (y = 2 →
    // top row), so the drag is purely horizontal.
    const note: NoteEvent = { id: "n1", pitch: 84, start: STEP_TICKS, duration: STEP_TICKS, velocity: 0.8 };
    const { project, track, container } = renderLiveRoll(note);
    const noteEl = container.querySelector<HTMLElement>(`[data-note-id="n1"]`)!;
    vi.spyOn(noteEl, "getBoundingClientRect").mockReturnValue({
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
    const gridEl = container.querySelector<HTMLElement>(".pianoroll-grid") ?? noteEl;
    vi.spyOn(gridEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 160,
      height: 240,
      right: 160,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(noteEl, { button: 0, altKey: true, clientX: 4, clientY: 2, pointerId: 1 });
    // 32 px at the stubbed grid (160 px / 16 steps) = 3.2 steps → rounds to 3.
    fireEvent.pointerMove(noteEl, { clientX: 36, clientY: 2, pointerId: 1 });
    fireEvent.pointerUp(noteEl, { pointerId: 1 });

    const notes = noteIn(project, track.id);
    expect(notes).toHaveLength(2);
    const moved = notes.find((n) => n.id !== "n1")!;
    expect(moved.start).toBe(note.start + 3 * STEP_TICKS);
    expect(moved.pitch).toBe(84);
  });
});

describe("alt-drag is ONE undo transaction", () => {
  const stubRects = (noteEl: HTMLElement, container: HTMLElement) => {
    vi.spyOn(noteEl, "getBoundingClientRect").mockReturnValue({
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
    const gridEl = container.querySelector<HTMLElement>(".pianoroll-grid") ?? noteEl;
    vi.spyOn(gridEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 160,
      height: 240,
      right: 160,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    return gridEl;
  };

  it("one Ctrl+Z removes the duplicate AND its move", () => {
    // Pitch 84 = the grid row the stubbed pointer touches, so the drag is
    // purely horizontal.
    const note: NoteEvent = { id: "n1", pitch: 84, start: STEP_TICKS, duration: STEP_TICKS, velocity: 0.8 };
    const { project, track, container } = renderLiveRoll(note);
    const noteEl = container.querySelector<HTMLElement>(`[data-note-id="n1"]`)!;
    stubRects(noteEl, container);

    fireEvent.pointerDown(noteEl, { button: 0, altKey: true, clientX: 4, clientY: 2, pointerId: 1 });
    fireEvent.pointerMove(noteEl, { clientX: 36, clientY: 2, pointerId: 1 });
    fireEvent.pointerUp(noteEl, { pointerId: 1 });
    expect(noteIn(project, track.id)).toHaveLength(2);

    // The gesture created exactly ONE history entry: a single undo returns
    // to the pristine pre-gesture state (duplicate removed AND the move
    // reverted — pre-fix this needed two presses, leaving the copy stacked
    // on the original after the first).
    act(() => {
      project.undo();
    });
    const notes = noteIn(project, track.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe("n1");
    expect(notes[0]!.start).toBe(note.start);
    expect(project.canUndo).toBe(false);
  });

  it("cancel after materialization keeps the duplicate as its own single entry", () => {
    const note: NoteEvent = { id: "n1", pitch: 84, start: STEP_TICKS, duration: STEP_TICKS, velocity: 0.8 };
    const { project, track, container } = renderLiveRoll(note);
    const noteEl = container.querySelector<HTMLElement>(`[data-note-id="n1"]`)!;
    stubRects(noteEl, container);

    fireEvent.pointerDown(noteEl, { button: 0, altKey: true, clientX: 4, clientY: 2, pointerId: 1 });
    fireEvent.pointerMove(noteEl, { clientX: 36, clientY: 2, pointerId: 1 });
    // Interrupted after the duplicate committed but before the move — the
    // frame closes with a single command and must NOT swallow it.
    fireEvent.pointerCancel(noteEl, { pointerId: 1 });
    expect(noteIn(project, track.id)).toHaveLength(2);

    act(() => {
      project.undo();
    });
    const notes = noteIn(project, track.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe("n1");
  });
});

describe("paste clamps into the pattern", () => {
  it("notes beyond patternTicks land inside it", () => {
    // The clipboard note starts at step 25 — far past the 8-step pattern the
    // roll is mounted on (a copy taken from a longer pattern / earlier
    // session). Pre-fix the paste wrote the note at start 3000, where it
    // never sounded and only normalizeProject's silent drop removed it.
    const note: NoteEvent = { id: "n1", pitch: 84, start: 25 * STEP_TICKS, duration: STEP_TICKS, velocity: 0.8 };
    const doc = createProjectFromTemplate("house");
    const track = doc.tracks.find((t) => t.kind === "instrument")!;
    const pattern = doc.patterns[0]!;
    pattern.notes = { [track.id]: [note] };
    const { project, services } = liveServices(doc);
    renderWithContext(
      <PianoRollTrack
        track={track}
        pattern={{ ...pattern, stepCount: 8 }}
        playheadStep={-1}
        selectedNote={{ trackId: track.id, noteIds: ["n1"] }}
        onSelectNote={vi.fn()}
        scaleSnap={false}
      />,
      { services },
    );

    fireEvent.click(screen.getByRole("button", { name: "COPY" }));
    fireEvent.click(screen.getByRole("button", { name: "PASTE" }));

    const pasted = noteIn(project, track.id).find((n) => n.id !== "n1")!;
    expect(pasted).toBeDefined();
    // Clamped to the last slot that fits the note's duration.
    expect(pasted.start).toBe(8 * STEP_TICKS - pasted.duration);
    expect(pasted.start + pasted.duration).toBeLessThanOrEqual(8 * STEP_TICKS);
  });
});

describe("usePointerDragGuard", () => {
  function Probe({ onEnd, onCancel, armed }: { onEnd: () => void; onCancel: () => void; armed: boolean }) {
    const guard = usePointerDragGuard();
    guard.handlers.current = { onEnd, onCancel };
    useEffect(() => {
      if (armed) guard.arm();
      return () => guard.disarm();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [armed]);
    return null;
  }

  it("routes a window pointerup to onEnd exactly once", () => {
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    renderWithContext(<Probe onEnd={onEnd} onCancel={onCancel} armed />, {});
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    // Disarmed after the first termination — no double delivery.
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("unmount mid-gesture cancels (never commits)", () => {
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    const utils = renderWithContext(<Probe onEnd={onEnd} onCancel={onCancel} armed />, {});
    utils.unmount();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });
});

/* -----------------------------------------------------------------------
 * Wave B (2026-10-07): ripple move left floor. jsdom rects are all-zero,
 * which makes every scene-clip press a "resize" (clientX > right - 10) and
 * every lane conversion degenerate — give elements a wide, left-anchored
 * rect so px→bar math is clientX/30 (zoom 1).
 */
describe("ripple move left floor (panel preview + commit)", () => {
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = undefined;
  });
  function useWideRects(): void {
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 10_000,
      bottom: 100,
      width: 10_000,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect);
  }

  function threeClipDoc(): { doc: ProjectDocument; bId: string; cId: string } {
    const base = createProjectFromTemplate("house");
    const cleared = { ...base, arrangement: { ...base.arrangement, clips: [] } };
    let doc = addArrangementClip(cleared, cleared.scenes[0]!.id, 0, 4).execute(cleared); // A [0,4)
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 10, 4).execute(doc); // B [10,14)
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 16, 4).execute(doc); // C [16,20)
    return {
      doc,
      bId: doc.arrangement.clips.find((c) => c.startBar === 10)!.id,
      cId: doc.arrangement.clips.find((c) => c.startBar === 16)!.id,
    };
  }

  const noOverlap = (doc: ProjectDocument): void => {
    const sorted = [...doc.arrangement.clips].sort((x, y) => x.startBar - y.startBar);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i]!.startBar).toBeGreaterThanOrEqual(sorted[i - 1]!.startBar + sorted[i - 1]!.lengthBars);
  };

  it("single ripple move stops at the predecessor instead of overlapping it", () => {
    useWideRects();
    const built = threeClipDoc();
    const { project } = renderLiveArrangement(built.doc);
    fireEvent.click(screen.getByRole("button", { name: /RIPPLE/ }));
    const els = clipEls();
    expect(els.length).toBe(3);
    // Press clip B (bar 10.5), drag toward bar 1.5. Pre-fix the commit wrote
    // B at bar 1, ON TOP of A[0,4).
    fireEvent.pointerDown(els[1]!, { button: 0, pointerId: 1, clientX: 315 });
    fireEvent.pointerMove(els[1]!, { pointerId: 1, clientX: 45 });
    fireEvent.pointerUp(els[1]!, { pointerId: 1, clientX: 45 });
    const moved = project.getDoc().arrangement.clips.find((c) => c.id === built.bId)!;
    expect(moved.startBar).toBe(4);
    noOverlap(project.getDoc());
  });

  it("multi ripple block stops at the stationary predecessor (no pile-up)", () => {
    useWideRects();
    const built = threeClipDoc();
    const { project } = renderLiveArrangement(built.doc);
    fireEvent.click(screen.getByRole("button", { name: /RIPPLE/ }));
    const els = clipEls();
    // Ctrl+click selects B and C; a plain press on B then block-moves them.
    fireEvent.pointerDown(els[1]!, { button: 0, pointerId: 1, clientX: 315, ctrlKey: true });
    fireEvent.pointerDown(els[2]!, { button: 0, pointerId: 2, clientX: 495, ctrlKey: true });
    const els2 = clipEls();
    fireEvent.pointerDown(els2[1]!, { button: 0, pointerId: 3, clientX: 315 });
    fireEvent.pointerMove(els2[1]!, { pointerId: 3, clientX: 75 }); // bar 2.5 → raw delta −8 → floored to −6
    fireEvent.pointerUp(els2[1]!, { pointerId: 3, clientX: 75 });
    const clips = project.getDoc().arrangement.clips;
    expect(clips.find((c) => c.id === built.bId)!.startBar).toBe(4); // 10 − 6
    expect(clips.find((c) => c.id === built.cId)!.startBar).toBe(10); // 16 − 6, gap preserved
    noOverlap(project.getDoc());
  });
});

/* -----------------------------------------------------------------------
 * Cut tool (ADR 0025 razor): with the tool active, clicking any clip —
 * scene OR audio — splits it at the click position instead of dragging.
 * Scene cuts land on the bar grid (the command floors); audio cuts are
 * sample-precise, snapped when the snap grid is on.
 */
describe("cut tool (razor)", () => {
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = undefined;
    localStorage.removeItem("pf:arr-snap");
  });
  function useWideRects(): void {
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 10_000,
      bottom: 100,
      width: 10_000,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect);
  }
  function renderWithTool(doc: ProjectDocument) {
    const project = new ProjectStore(doc);
    const services = { ...mockServices(doc), store: project } as unknown as Services;
    const toolStore = new ToolStore();
    const utils = renderWithContext(
      <ToolContext.Provider value={toolStore}>
        <ArrangementPanel />
      </ToolContext.Provider>,
      { services },
    );
    return { ...utils, project, toolStore };
  }
  const clickClip = (el: HTMLElement, clientX: number): void => {
    fireEvent.pointerDown(el, { button: 0, pointerId: 9, clientX });
  };

  it("clicking a scene clip with the cut tool splits it at the click bar", () => {
    useWideRects();
    const doc = createProjectFromTemplate("house");
    const cleared = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
    let seeded = addArrangementClip(cleared, cleared.scenes[0]!.id, 0, 4).execute(cleared);
    seeded = addAudioClip(seeded, seeded.tracks.find((t) => t.kind !== "group")!.id, "buf-x", 0, 4).execute(seeded);
    const { project, toolStore } = renderWithTool(seeded);
    act(() => toolStore.setTool("cut"));

    const sceneStrip = Array.from(document.querySelectorAll<HTMLElement>(".arr-clip"))[0]!;
    clickClip(sceneStrip, 60); // bar 2

    const clips = project.getDoc().arrangement.clips;
    expect(clips.length).toBe(2);
    expect(clips[0]!.startBar).toBe(0);
    expect(clips[1]!.startBar).toBe(2);
  });

  it("clicking an audio clip with the cut tool splits sample-precise and honors the snap grid", () => {
    useWideRects();
    const doc = createProjectFromTemplate("house");
    const cleared = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
    let seeded = addAudioClip(cleared, cleared.tracks.find((t) => t.kind !== "group")!.id, "buf-y", 0, 4).execute(
      cleared,
    );
    seeded = addArrangementClip(seeded, seeded.scenes[0]!.id, 8, 4).execute(seeded);
    const { project, toolStore } = renderWithTool(seeded);
    act(() => toolStore.setTool("cut"));

    // Click at bar 2.4 with SNAP 1/2 (driven through the real selector) →
    // the cut snaps to the 2.5 grid line (half rounds up).
    fireEvent.change(screen.getByRole("combobox", { name: "Snap grid" }), { target: { value: "1/2" } });
    const audioEl = Array.from(document.querySelectorAll<HTMLElement>(".arr-audio-clip"))[0]!;
    clickClip(audioEl, 72); // 72/30 = 2.4 bars
    let audio = project.getDoc().arrangement.audioClips ?? [];
    expect(audio.length).toBe(2);
    expect(audio[1]!.startBar).toBeCloseTo(2.5, 6);

    // SNAP OFF → the same click cuts at the exact tick position (2.3 bars).
    // NOTE: splitAudioClipAtTick mints TWO fresh ids (unlike the scene split,
    // whose left fragment keeps the original id for transitions).
    fireEvent.change(screen.getByRole("combobox", { name: "Snap grid" }), { target: { value: "off" } });
    const el2 = Array.from(document.querySelectorAll<HTMLElement>(".arr-audio-clip"))[0]!;
    clickClip(el2, 69);
    audio = project.getDoc().arrangement.audioClips ?? [];
    expect(audio.length).toBe(3);
    expect(audio[0]!.startBar).toBeCloseTo(0, 6);
    expect(audio.some((c) => c.startBar === 2.3)).toBe(true);
  });

  it("select tool keeps dragging — pointerdown does not split", () => {
    useWideRects();
    const doc = createProjectFromTemplate("house");
    const cleared = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
    let seeded = addArrangementClip(cleared, cleared.scenes[0]!.id, 0, 4).execute(cleared);
    seeded = addAudioClip(seeded, seeded.tracks.find((t) => t.kind !== "group")!.id, "buf-z", 0, 4).execute(seeded);
    const { project, toolStore } = renderWithTool(seeded);
    act(() => toolStore.setTool("select"));

    clickClip(Array.from(document.querySelectorAll<HTMLElement>(".arr-clip"))[0]!, 60);
    expect(project.getDoc().arrangement.clips.length).toBe(1);
  });
});
