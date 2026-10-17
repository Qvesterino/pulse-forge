import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModPanel } from "../../src/ui/ModPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { AutomationLane } from "../../src/project-model/types";

/**
 * AUTOMATION POINT GESTURE GATE (seam: automation-point-drag)
 *
 * The seam ledger called this the LARGEST GAP: zero specs dispatched a
 * pointerDown anywhere near the auto-canvas, making it the gesture most
 * analogous to the EQ defect that shipped broken — 16/16 green function specs
 * while the user-facing gesture wrote the wrong value.
 *
 * These specs drive the REAL component through the REAL entry point
 * (`ModPanel` → `+ LANE` → lane row → `.auto-canvas` pointer events) against a
 * REAL `ProjectStore`, and they assert the NEGATIVE cases first: a press with
 * no move, and an interrupted drag, must commit NOTHING. A happy-path-only
 * spec cannot see the defect class that actually ships (a release that
 * commits a no-op, or a cancel that still writes).
 *
 * Geometry is stubbed deterministically: canvas rect = (0,0,200,100),
 * patternTicks = 16 steps × 120 = 1920, trackGain range = 0…1.5.
 *   - empty press at (100,50) → tick 960, value 0.75
 *   - that point renders at (100,50), inside the 9 px hit radius
 *   - drag to (140,20) → tick 1320, value 1.2
 */

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

function setup() {
  const doc = createProjectFromTemplate("house");
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  renderWithContext(<ModPanel />, { services });
  return { project };
}

/** The lane the spec just created (appended last), straight from the store. */
function lastLane(project: ProjectStore): AutomationLane {
  const lanes = project.doc.automation ?? [];
  expect(lanes.length, "no automation lane in the document — the probe measured nothing").toBeGreaterThan(0);
  return lanes[lanes.length - 1]!;
}

async function openCanvas(project: ProjectStore) {
  const user = userEvent.setup();
  // Two "+ LANE" buttons exist (pattern automation, scene automation); the
  // FIRST belongs to the pattern section this seam lives in.
  await user.click(screen.getAllByRole("button", { name: "+ LANE" })[0]!);
  const labels = document.querySelectorAll(".mod-lane-label");
  expect(labels.length, "lane row did not render — the probe measured nothing").toBeGreaterThan(0);
  await user.click(labels[labels.length - 1] as HTMLElement);
  const canvas = document.querySelector(".auto-canvas") as HTMLElement | null;
  expect(canvas, "auto-canvas did not render — the probe measured nothing").not.toBeNull();
  vi.spyOn(canvas!, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 200, 100));
  expect(lastLane(project).points, "the selected lane is not the one just created").toHaveLength(0);
  return canvas!;
}

/** The positive control: press empty canvas once so there IS a point to drag. */
function addFirstPoint(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
}

afterEach(() => cleanup());

describe("automation point gesture (seam: automation-point-drag)", () => {
  it("an empty-canvas press adds exactly one point at the computed tick/value", async () => {
    const { project } = setup();
    const canvas = await openCanvas(project);

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });

    const points = lastLane(project).points;
    expect(points).toHaveLength(1);
    expect(points[0]!.tick).toBe(960);
    expect(points[0]!.value).toBeCloseTo(0.75, 6);
    expect(project.undoStackLength).toBe(2); // addAutomationLane + addAutomationPoint
  });

  it("NEGATIVE: press + release with NO move commits nothing", async () => {
    const { project } = setup();
    const canvas = await openCanvas(project);
    addFirstPoint(canvas);
    const before = lastLane(project).points.map((p) => ({ ...p }));
    const undoBefore = project.undoStackLength;

    // Grab the point (it renders at 100,50) and release without moving.
    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    expect(lastLane(project).points).toEqual(before);
    expect(project.undoStackLength).toBe(undoBefore);
  });

  it("NEGATIVE: an interrupted drag (pointercancel) commits nothing", async () => {
    const { project } = setup();
    const canvas = await openCanvas(project);
    addFirstPoint(canvas);
    const before = lastLane(project).points.map((p) => ({ ...p }));
    const undoBefore = project.undoStackLength;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 20, pointerId: 1 });
    fireEvent.pointerCancel(canvas, { pointerId: 1 });

    // The live preview aborted; the stored point is untouched and no undo entry
    // was pushed.
    expect(lastLane(project).points).toEqual(before);
    expect(project.undoStackLength).toBe(undoBefore);
  });

  it("a drag commits exactly ONE command on release, at the dropped position", async () => {
    const { project } = setup();
    const canvas = await openCanvas(project);
    addFirstPoint(canvas);
    const undoBefore = project.undoStackLength;

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    const points = lastLane(project).points;
    expect(points).toHaveLength(1);
    expect(points[0]!.tick).toBe(1320);
    expect(points[0]!.value).toBeCloseTo(1.2, 6);
    // Exactly one command for the whole gesture — a per-move commit would pile
    // up undo entries (and push older history off the 256-entry cap).
    expect(project.undoStackLength).toBe(undoBefore + 1);
  });

  it("NEGATIVE: a right-button press is not a gesture", async () => {
    const { project } = setup();
    const canvas = await openCanvas(project);

    fireEvent.pointerDown(canvas, { button: 2, clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });

    expect(lastLane(project).points).toHaveLength(0);
    expect(project.undoStackLength).toBe(1); // only the lane creation
  });
});
