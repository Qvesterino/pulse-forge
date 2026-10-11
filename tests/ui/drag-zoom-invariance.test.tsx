import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip } from "../../src/commands/arrangement";
import { addAudioClip } from "../../src/commands/audioClips";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * §13 ZOOM × §31 RACES — a live drag must convert pixels to bars in ONE unit
 * system.
 *
 * The hazard is specific: `barWidth` is a RENDER value (`BASE_BAR_WIDTH *
 * zoom`) and the Ctrl+wheel handler is live during a gesture. A drag that
 * reads `barWidth` from the render converts its grab position with the old
 * scale and its release position with the new one, so the delta is a
 * difference of two scales and the clip lands where the pointer never was —
 * silently, because every intermediate value is a legal bar.
 *
 * This closes the audit's remaining-risk item "mid-drag zoom re-scales a live
 * drag (UNCONFIRMED)". The capture that prevents it is `DragState.barWidth`
 * / `audioDragRef.barWidth`; this pins the behaviour, not the implementation,
 * so a refactor that drops the capture fails here.
 */

const domRect = (left: number, width: number) =>
  ({ left, top: 0, width, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

function mount(doc: ProjectDocument) {
  const store = new ProjectStore(doc);
  const services = { ...mockServices(doc), store } as unknown as Services;
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(
        SelectionContext.Provider,
        { value: new SelectionStore() },
        createElement(ArrangementPanel) as ReactElement,
      ),
    ),
  );
  const lane = document.querySelector(".arr-lane")!;
  vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 4_000_000));
  const remeasure = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].forEach((el) =>
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue(domRect(0, 100)),
    );
  remeasure(".arr-clip");
  remeasure(".arr-audio-clip");
  return { store, lane };
}

const zoomIn = () => {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  });
};

afterEach(() => cleanup());

describe("§13 zoom — a live drag keeps its own scale", () => {
  it("CONTROL: a scene clip drag with no zoom commits the pointer's delta", () => {
    let doc = createProjectFromTemplate("house");
    for (const c of [...doc.arrangement.clips]) {
      doc = { ...doc, arrangement: { ...doc.arrangement, clips: doc.arrangement.clips.filter((x) => x.id !== c.id) } };
    }
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 8).execute(doc);
    const id = doc.arrangement.clips[0]!.id;
    const { store } = mount(doc);
    const el = document.querySelector(".arr-clip")!;
    // 30px/bar at zoom 1: grab at bar 1 (x=40), release at bar 8 (x=240).
    fireEvent.pointerDown(el, { button: 0, clientX: 40, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(el, { clientX: 240, pointerId: 1 });
    });
    fireEvent.pointerUp(el, { clientX: 240, pointerId: 1 });
    expect(store.doc.arrangement.clips.find((c) => c.id === id)!.startBar).toBe(7);
  });

  it("zooming MID-DRAG does not re-scale the scene gesture", () => {
    let doc = createProjectFromTemplate("house");
    doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] } };
    doc = addArrangementClip(doc, doc.scenes[0]!.id, 0, 8).execute(doc);
    const id = doc.arrangement.clips[0]!.id;
    const { store } = mount(doc);
    const el = document.querySelector(".arr-clip")!;
    fireEvent.pointerDown(el, { button: 0, clientX: 40, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(el, { clientX: 240, pointerId: 1 });
    });
    zoomIn(); // barWidth 30 → 42, mid-gesture
    const afterZoom = document.querySelector(".arr-clip")!;
    act(() => {
      fireEvent.pointerMove(afterZoom, { clientX: 240, pointerId: 1 });
    });
    fireEvent.pointerUp(afterZoom, { clientX: 240, pointerId: 1 });
    // Same pointer, same gesture: still +7 bars. Reading the render's new
    // scale here would give floor(240/42)=5, i.e. +4 bars.
    expect(store.doc.arrangement.clips.find((c) => c.id === id)!.startBar).toBe(7);
  });

  it("zooming MID-DRAG does not re-scale the audio gesture", () => {
    let doc = createProjectFromTemplate("house");
    const trackId = doc.tracks.find((t) => t.kind !== "group")!.id;
    doc = addAudioClip(doc, trackId, "zoom-buf", 0, 4, {}).execute(doc);
    const id = doc.arrangement.audioClips![0]!.id;
    const { store } = mount(doc);
    const el = document.querySelector(".arr-audio-clip")!;
    const startBar = store.doc.arrangement.audioClips![0]!.startBar;
    fireEvent.pointerDown(el, { button: 0, clientX: 60, pointerId: 3 });
    act(() => {
      fireEvent.pointerMove(el, { clientX: 240, pointerId: 3 });
    });
    zoomIn();
    const afterZoom = document.querySelector(".arr-audio-clip")!;
    act(() => {
      fireEvent.pointerMove(afterZoom, { clientX: 240, pointerId: 3 });
    });
    fireEvent.pointerUp(afterZoom, { clientX: 240, pointerId: 3 });
    const moved = store.doc.arrangement.audioClips!.find((c) => c.id === id)!.startBar;
    // 180px at the gesture's own 30px/bar = +6 bars. With the post-zoom
    // 42px/bar the same pointer would read +4.28 bars.
    expect(moved).toBeCloseTo(startBar + 6, 5);
  });
});
