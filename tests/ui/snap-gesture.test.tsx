import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addAudioClip } from "../../src/commands/commands";
import { snapController } from "../../src/ui/snap";
import { mockServices } from "../helpers";
import type { ProjectDocument } from "../../src/project-model/types";
import type { Services } from "../../src/services";

/**
 * SNAP GESTURE INTEGRATION (v1 targets): drag an audio clip with the grid ON
 * and prove the SECONDARY targets do what the engine promises end-to-end —
 * a neighbour's edge catches the pointer away from the grid line, a marker
 * tick catches too, and grid OFF stays completely free. Complements the pure
 * engine tests in timeline-snap-targets.test.ts.
 *
 * Geometry: barWidth is 30 px in this harness, so the pull threshold is
 * 8/30 ≈ 0.267 bars.
 */

const domRect = (left: number, width: number) =>
  ({
    left,
    top: 0,
    width,
    height: 40,
    right: left + width,
    bottom: 40,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

function docWithClips(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  // The dragged clip sits at bar 0; the neighbour's start edge (4.5) is the
  // secondary target, plus a marker at 3.25 bars.
  let doc = addAudioClip(base, trackId, "drag-me", 0, 2).execute(base);
  doc = addAudioClip(doc, trackId, "neighbour", 4.5, 2).execute(doc);
  return {
    ...doc,
    markers: [...doc.markers, { id: "snap-marker", name: "M", type: "cue" as const, tick: 3.25 * 1920 }],
  };
}

function renderLive(doc: ProjectDocument): { project: ProjectStore } {
  const project = new ProjectStore(doc);
  const selectionStore = new SelectionStore();
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(
        SelectionContext.Provider,
        { value: selectionStore },
        createElement(ArrangementPanel) as ReactElement,
      ),
    ),
  );
  const lane = document.querySelector(".arr-lane");
  if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 2000));
  return { project };
}

const dragged = (doc: ProjectDocument) => doc.arrangement.audioClips!.find((c) => c.bufferId === "drag-me")!;

/**
 * Drag the FIRST rendered clip's body (plain move, no modifier) so that the
 * UNSNAPPED landing is `finalBar`. Geometry: pointerdown at bar 0.5 keeps
 * origStart + delta positive (the move commit floors at 0 — a negative delta
 * would clamp the clip at bar 0 and test nothing).
 */
function dragToUnsnapped(doc: ProjectDocument, finalBar: number): ProjectDocument {
  cleanup();
  const { project } = renderLive(doc);
  const target = document.querySelector(".arr-audio-clip") as HTMLElement;
  expect(target, "dragged clip rendered").not.toBeNull();
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(domRect(400, 200));

  // Pointerdown must land in the clip BODY (mock rect 400..600): the body
  // branch reads x = clientX - rect.left — x < 8 would start a TRIM, not a
  // move. grabBar is measured against the LANE rect (0..2000 @ 30 px/bar).
  const grabBar = 500 / 30;
  const downX = 500;
  const upX = (grabBar + finalBar) * 30; // final = origStart(0) + (bar - grab)
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: downX, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointermove", { clientX: upX, pointerId: 1, bubbles: true }));
  });
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerup", { clientX: upX, pointerId: 1, bubbles: true }));
  });
  return project.getDoc();
}

describe("snap gesture integration", () => {
  afterEach(() => {
    snapController.setGrid("off"); // singleton — restore the default
    cleanup();
  });

  it("a neighbour's edge catches the pointer away from the grid line (grid ON)", () => {
    snapController.setGrid("1");
    // Unsnapped landing 4.55: grid "1" would put it on 5.0; the neighbour's
    // start edge at 4.5 is 0.05 away (within the 0.267-bar pull) and strictly
    // closer — it must win.
    const after = dragToUnsnapped(docWithClips(), 4.55);
    expect(dragged(after).startBar).toBeCloseTo(4.5, 6);
  });

  it("a marker tick catches too", () => {
    snapController.setGrid("1");
    // Unsnapped 3.2: grid would say 3.0, the marker at 3.25 is 0.05 away.
    const after = dragToUnsnapped(docWithClips(), 3.2);
    expect(dragged(after).startBar).toBeCloseTo(3.25, 6);
  });

  it("grid OFF stays completely free (no target magnet)", () => {
    snapController.setGrid("off");
    const after = dragToUnsnapped(docWithClips(), 4.55);
    expect(dragged(after).startBar).toBeCloseTo(4.55, 2);
  });

  it("grid ON without nearby targets snaps to the grid line", () => {
    snapController.setGrid("1");
    // Unsnapped 4.55 with NO neighbour and NO marker: plain grid snap → 5.
    const base = createProjectFromTemplate("house");
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const solo = addAudioClip(base, trackId, "drag-me", 0, 2).execute(base);
    const after = dragToUnsnapped(solo, 4.55);
    expect(dragged(after).startBar).toBeCloseTo(5, 6);
  });
});
