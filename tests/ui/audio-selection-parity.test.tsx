import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { useSelection } from "../../src/ui/context";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip } from "../../src/commands/arrangement";
import { addAudioClip } from "../../src/commands/audioClips";
import { mockServices, renderWithContext } from "../helpers";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * Audio-clip selection parity (editor wave A). Audio clips now feed the SAME
 * shared selection store as scene clips, so every behavior pinned here was
 * previously scene-clip-only:
 *
 *  - plain/ctrl/shift click fill selectionStore.clipIds (keyboard Delete,
 *    `P` locators and the context menu already route both clip kinds);
 *  - the lane marquee selects scene AND audio clips it spans;
 *  - a plain press on a selected clip inside a multi-selection block-moves
 *    every selected audio clip in ONE undo entry;
 *  - Escape cancels the block move like any other gesture.
 *
 * Plus the Ctrl+E error bridge: a failed split at playhead used to vanish in
 * an empty catch; it now lands in the panel's error strip.
 */

// jsdom rects are all-zero, which collapses the panel's pixel hit-zones (an
// audio clip would be "always the left trim edge" and the lane width 0). Give
// every element a wide, left-anchored rect so clientX maps straight to lane px
// at 30 px/bar (zoom 1).
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
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
afterEach(() => {
  rectSpy?.mockRestore();
  rectSpy = undefined;
});

const SelectionProbe = () => {
  const selection = useSelection();
  return <div data-testid="clip-selection">{selection.clipIds.join(",")}</div>;
};

function parityDoc(): { doc: ProjectDocument; sceneClipId: string; audioA: string; audioB: string } {
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
  const track = doc.tracks.find((t) => t.kind !== "group")!;
  doc = addAudioClip(doc, track.id, "buf-a", 0, 4).execute(doc);
  doc = addAudioClip(doc, track.id, "buf-b", 6, 2).execute(doc);
  doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 4).execute(doc);
  return {
    doc,
    sceneClipId: doc.arrangement.clips[0]!.id,
    audioA: (doc.arrangement.audioClips ?? []).find((c) => c.startBar === 0)!.id,
    audioB: (doc.arrangement.audioClips ?? []).find((c) => c.startBar === 6)!.id,
  };
}

function renderLiveArrangement(doc: ProjectDocument) {
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  const utils = renderWithContext(
    <>
      <ArrangementPanel />
      <SelectionProbe />
    </>,
    { services },
  );
  return { ...utils, project };
}

const selectedIds = (): string[] =>
  screen
    .getByTestId("clip-selection")
    .textContent!.split(",")
    .filter((id) => id !== "");

const audioClipEls = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".arr-audio-clip"));

/** Plain pointerdown on an audio clip (selection happens at pointerdown; cancel aborts the gesture). */
function clickAudioClip(el: HTMLElement, pointerId: number, clientX: number, mods: Record<string, unknown> = {}): void {
  fireEvent.pointerDown(el, { button: 0, pointerId, clientX, ...mods });
  fireEvent.pointerCancel(el, { pointerId });
}

function audioStartBars(project: ProjectStore): Map<string, number> {
  return new Map((project.getDoc().arrangement.audioClips ?? []).map((c) => [c.id, c.startBar] as const));
}

describe("audio clip shared-selection parity", () => {
  it("plain click puts the audio clip into selectionStore.clipIds", () => {
    useWideRects();
    const { doc, audioA } = parityDoc();
    renderLiveArrangement(doc);
    clickAudioClip(audioClipEls()[0]!, 1, 100); // bar 3.33 — clip body
    expect(selectedIds()).toEqual([audioA]);
  });

  it("ctrl+click toggles audio clips in the multi-selection", () => {
    useWideRects();
    const { doc, audioA, audioB } = parityDoc();
    renderLiveArrangement(doc);
    const els = audioClipEls();
    clickAudioClip(els[0]!, 1, 100);
    clickAudioClip(audioClipEls()[1]!, 2, 230, { ctrlKey: true }); // bar 7.67 — inside B
    expect(selectedIds()).toEqual([audioA, audioB]);
    clickAudioClip(audioClipEls()[0]!, 3, 100, { ctrlKey: true });
    expect(selectedIds()).toEqual([audioB]);
  });

  it("the lane marquee selects scene AND audio clips it spans", () => {
    useWideRects();
    const { doc, sceneClipId, audioA, audioB } = parityDoc();
    renderLiveArrangement(doc);
    const lane = document.querySelector<HTMLElement>(".arr-lane")!;
    // The marquee commit floors the release bar (place-a-scene contract), so
    // end past bar 7 to span clip B (starts at bar 6).
    fireEvent.pointerDown(lane, { button: 0, pointerId: 3, clientX: 15 }); // bar 0.5
    fireEvent.pointerMove(lane, { pointerId: 3, clientX: 210 }); // bar 7
    fireEvent.pointerUp(lane, { pointerId: 3, clientX: 210 });
    const got = selectedIds();
    expect(got).toContain(sceneClipId);
    expect(got).toContain(audioA);
    expect(got).toContain(audioB);
  });

  it("a plain empty-lane click clears the selection", () => {
    useWideRects();
    const { doc } = parityDoc();
    renderLiveArrangement(doc);
    clickAudioClip(audioClipEls()[0]!, 1, 100);
    expect(selectedIds().length).toBe(1);
    const lane = document.querySelector<HTMLElement>(".arr-lane")!;
    fireEvent.pointerDown(lane, { button: 0, pointerId: 2, clientX: 300 });
    fireEvent.pointerUp(lane, { pointerId: 2, clientX: 302 }); // < 0.15 bars → click
    expect(selectedIds()).toEqual([]);
  });
});

describe("audio block move (multi-selection drag)", () => {
  function selectBoth(): void {
    clickAudioClip(audioClipEls()[0]!, 1, 100);
    clickAudioClip(audioClipEls()[1]!, 2, 230, { ctrlKey: true });
  }

  it("moves every selected audio clip by the shared delta in one undo entry", () => {
    useWideRects();
    const { doc, audioA, audioB } = parityDoc();
    const { project } = renderLiveArrangement(doc);
    selectBoth();
    const elA = audioClipEls()[0]!;
    fireEvent.pointerDown(elA, { button: 0, pointerId: 4, clientX: 100 }); // grab ≈ bar 3.33
    fireEvent.pointerMove(elA, { pointerId: 4, clientX: 160 }); // delta ≈ +2 bars
    fireEvent.pointerUp(elA, { pointerId: 4, clientX: 160 });

    let bars = audioStartBars(project);
    expect(bars.get(audioA)).toBeCloseTo(2, 6);
    expect(bars.get(audioB)).toBeCloseTo(8, 6);
    // ONE undo entry reverts the whole block.
    project.undo();
    bars = audioStartBars(project);
    expect(bars.get(audioA)).toBeCloseTo(0, 6);
    expect(bars.get(audioB)).toBeCloseTo(6, 6);
  });

  it("Escape cancels the block move without committing", () => {
    useWideRects();
    const { doc, audioA, audioB } = parityDoc();
    const { project } = renderLiveArrangement(doc);
    selectBoth();
    const elA = audioClipEls()[0]!;
    fireEvent.pointerDown(elA, { button: 0, pointerId: 4, clientX: 100 });
    fireEvent.pointerMove(elA, { pointerId: 4, clientX: 160 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(elA, { pointerId: 4, clientX: 160 });
    const bars = audioStartBars(project);
    expect(bars.get(audioA)).toBeCloseTo(0, 6);
    expect(bars.get(audioB)).toBeCloseTo(6, 6);
  });

  it("press+release without movement is a click, not a zero-delta history entry", () => {
    useWideRects();
    const { doc } = parityDoc();
    const { project } = renderLiveArrangement(doc);
    selectBoth();
    const elA = audioClipEls()[0]!;
    fireEvent.pointerDown(elA, { button: 0, pointerId: 4, clientX: 100 });
    fireEvent.pointerUp(elA, { pointerId: 4, clientX: 100 });
    const bars = audioStartBars(project);
    expect([...bars.values()].every((v) => Number.isFinite(v))).toBe(true);
    // No undoable entry was pushed: undo must not change any audio startBar.
    const before = audioStartBars(project);
    project.undo();
    const after = audioStartBars(project);
    for (const [id, bar] of before) expect(after.get(id)).toBe(bar);
  });
});

describe("Ctrl+E split-failure bridge", () => {
  it("app-disposed split errors surface in the panel error strip", () => {
    useWideRects();
    const { doc } = parityDoc();
    renderLiveArrangement(doc);
    expect(document.querySelector(".arr-error")).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("pf-arrangement-action-error", { detail: "Split too close to edge" }));
    });
    expect(document.querySelector(".arr-error")?.textContent).toContain("Split too close to edge");
  });
});

/* -----------------------------------------------------------------------
 * Snap system: the arrangement's snap grid drives audio-clip drags —
 * absolute snap for single moves, Shift suspends mid-drag, OFF keeps the
 * free (tick-precision) behavior.
 */
describe("snap grid drives audio-clip drags", () => {
  afterEach(() => {
    localStorage.removeItem("pf:arr-snap");
  });

  function setSnap(value: string): void {
    fireEvent.change(screen.getByRole("combobox", { name: "Snap grid" }), { target: { value } });
  }

  function dragFirstClip(moveClientX: number, upClientX: number, mods: Record<string, unknown> = {}): void {
    const el = audioClipEls()[0]!;
    fireEvent.pointerDown(el, { button: 0, pointerId: 7, clientX: 100, ...mods });
    fireEvent.pointerMove(el, { pointerId: 7, clientX: moveClientX, ...mods });
    fireEvent.pointerUp(el, { pointerId: 7, clientX: upClientX, ...mods });
  }

  it("SNAP 1/2 pulls a 1.3-bar drag onto the half-bar grid", () => {
    useWideRects();
    const { doc, audioA } = parityDoc();
    const { project } = renderLiveArrangement(doc);
    setSnap("1/2");
    dragFirstClip(139, 139); // grab 3.333b → 4.633b = +1.3 bars raw
    expect(project.getDoc().arrangement.audioClips?.find((c) => c.id === audioA)!.startBar).toBeCloseTo(1.5, 9);
  });

  it("holding Shift MID-DRAG suspends the grid (Shift at pointerdown is range-select)", () => {
    useWideRects();
    const { doc, audioA } = parityDoc();
    const { project } = renderLiveArrangement(doc);
    setSnap("1/2");
    // Plain press starts the drag (Shift+press = range-select, no drag);
    // pressing Shift only for the move/up suspends the grid.
    const el = audioClipEls()[0]!;
    fireEvent.pointerDown(el, { button: 0, pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 139, shiftKey: true });
    fireEvent.pointerUp(el, { pointerId: 7, clientX: 139, shiftKey: true });
    // Free placement at tick precision: 1.3 bars = 2496 ticks exactly.
    expect(project.getDoc().arrangement.audioClips?.find((c) => c.id === audioA)!.startBar).toBeCloseTo(1.3, 9);
  });

  it("SNAP OFF keeps the exact pre-snap free behavior", () => {
    useWideRects();
    const { doc, audioA } = parityDoc();
    const { project } = renderLiveArrangement(doc);
    dragFirstClip(139, 139);
    expect(project.getDoc().arrangement.audioClips?.find((c) => c.id === audioA)!.startBar).toBeCloseTo(1.3, 9);
  });
});
