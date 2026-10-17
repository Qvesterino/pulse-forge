import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { Mixer } from "../../src/ui/Mixer";
import { ProjectStore } from "../../src/store/ProjectStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { renderWithContext, mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * MIXER FADER GESTURE GATE (seam: mixer-fader)
 *
 * The seam ledger marked this COVERED_NO_NEGATIVE: the existing spec drove the
 * shared Slider directly with ONE fixed clientX and no pointerMove, so a
 * move-sensitive defect would escape it, and it never drove the actual Mixerin
 * strip. These specs drag the REAL strip fader (`label="VOL"`, linear taper
 * 0…1.5) against a REAL `ProjectStore` and assert the moved position, the
 * UI↔document agreement, and the interrupted-gesture negative.
 *
 * Geometry: the track rect is stubbed 100×20 at the origin, so with the linear
 * taper the value is exactly `1.5 × clientX / 100`.
 */

function setup() {
  const doc = createProjectFromTemplate("house");
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;
  // The strip fader previews through the engine; the shared mock does not
  // implement this one.
  (services.engine as unknown as { previewTrackGain: unknown }).previewTrackGain = vi.fn();
  renderWithContext(<Mixer />, { services });
  const trackId = doc.tracks.find((t) => t.kind === "instrument")!.id;
  const nameInput = document.querySelector(`[aria-label="Track ${trackId} name"]`);
  expect(nameInput, "track strip did not render — the probe measured nothing").not.toBeNull();
  const strip = nameInput!.closest(".channel-strip") as HTMLElement;
  const slider = within(strip).getByRole("slider", { name: "VOL" }) as HTMLElement;
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 20,
    right: 100,
    bottom: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return { project, trackId, slider };
}

const gainOf = (project: ProjectStore, trackId: string) => project.doc.tracks.find((t) => t.id === trackId)!.gain;

afterEach(() => cleanup());

describe("mixer fader gesture (seam: mixer-fader)", () => {
  it("dragging the strip fader commits the DROPPED position, not the press position", () => {
    const { project, trackId, slider } = setup();
    expect(project.undoStackLength).toBe(0);

    // Press at 20% (0.3), drop at 80% (1.2): a defect reading the press
    // position would commit 0.3.
    fireEvent.pointerDown(slider, { button: 0, clientX: 20, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 80, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });

    expect(gainOf(project, trackId)).toBeCloseTo(1.2, 6);
    expect(project.undoStackLength).toBe(1);
    // The strip and the document agree after the commit.
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeCloseTo(1.2, 6);
  });

  it("dragging back down commits the lower value (direction fidelity)", () => {
    const { project, trackId, slider } = setup();

    fireEvent.pointerDown(slider, { button: 0, clientX: 80, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 40, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });

    expect(gainOf(project, trackId)).toBeCloseTo(0.6, 6);
    expect(project.undoStackLength).toBe(1);
  });

  it("NEGATIVE: an interrupted drag (pointercancel) commits nothing", () => {
    const { project, trackId, slider } = setup();
    const before = gainOf(project, trackId);

    fireEvent.pointerDown(slider, { button: 0, clientX: 20, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 80, clientY: 10, pointerId: 1 });
    fireEvent.pointerCancel(slider, { pointerId: 1 });

    expect(gainOf(project, trackId)).toBe(before);
    expect(project.undoStackLength).toBe(0);
  });

  it("NEGATIVE: a non-left button never starts a fader gesture", () => {
    const { project, trackId, slider } = setup();
    const before = gainOf(project, trackId);

    fireEvent.pointerDown(slider, { button: 2, clientX: 80, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 90, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });

    expect(gainOf(project, trackId)).toBe(before);
    expect(project.undoStackLength).toBe(0);
  });
});
