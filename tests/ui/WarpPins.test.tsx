import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel, warpPinTickFromClientX } from "../../src/ui/ArrangementPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createDefaultProject } from "../../src/project-model/schema";
import { addAudioClip, updateAudioClip } from "../../src/commands/commands";
import type { Command } from "../../src/commands/types";

/**
 * Warp-pin dragging: pins are added by double-click / menu, but the whole
 * point of FL-style pins is bending time by hand. This drives the overlay
 * handle through a real pointer drag and asserts the committed marker tick.
 */

function docWithPin() {
  const base = createDefaultProject();
  const withClip = addAudioClip(base, base.tracks[0].id, "factory.loop", 0, 4).execute(base);
  const clipId = withClip.arrangement.audioClips![0].id;
  const doc = updateAudioClip(withClip, clipId, {
    warpMarkers: [{ timeSec: 1, tick: 960 }],
  }).execute(withClip);
  return { doc, clipId };
}

const domRect = (width: number) =>
  ({
    left: 0,
    top: 0,
    width,
    height: 40,
    right: width,
    bottom: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

afterEach(() => {
  vi.restoreAllMocks();
});

function appliedMarkerTick(services: ReturnType<typeof mockServices>, doc: Parameters<Command["execute"]>[0]) {
  const calls = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const command = calls[calls.length - 1][0] as Command;
  const next = command.execute(doc);
  return next.arrangement.audioClips!.find((c) => c.id === doc.arrangement.audioClips![0].id)!.warpMarkers!;
}

describe("warpPinTickFromClientX (drag math)", () => {
  // 4 bars = 7680 ticks across 400 px.
  it("maps pointer delta to ticks and clamps to the clip span", () => {
    expect(warpPinTickFromClientX(960, 100, 140, 400, 7680, 0, false)).toBe(1728);
    expect(warpPinTickFromClientX(960, 100, -1000, 400, 7680, 0, false)).toBe(1);
    expect(warpPinTickFromClientX(960, 100, 10000, 400, 7680, 0, false)).toBe(7679);
  });

  it("Shift snaps to 1/16", () => {
    expect(warpPinTickFromClientX(960, 100, 140, 400, 7680, 0, true)).toBe(1680);
  });

  it("returns null without geometry", () => {
    expect(warpPinTickFromClientX(960, 100, 140, 0, 7680, 0, false)).toBeNull();
    expect(warpPinTickFromClientX(960, 100, 140, 400, 0, 0, false)).toBeNull();
  });
});

describe("WarpPinsOverlay dragging", () => {
  it("drags a pin along the grid and commits the new tick", () => {
    const { doc } = docWithPin();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(domRect(400));
    const services = mockServices(doc);
    renderWithContext(<ArrangementPanel />, { services });
    const handle = screen.getByLabelText(/Warp pin 1/);
    // 4 bars = 7680 ticks across 400 px → +40 px = +768 ticks.
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 140 });
    fireEvent.pointerUp(handle, { clientX: 140 });
    const markers = appliedMarkerTick(services, doc);
    expect(markers).toHaveLength(1);
    expect(markers[0].tick).toBe(960 + 768);
    expect(markers[0].timeSec).toBe(1);
  });

  it("Shift snaps the drop to 1/16", () => {
    const { doc } = docWithPin();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(domRect(400));
    const services = mockServices(doc);
    renderWithContext(<ArrangementPanel />, { services });
    const handle = screen.getByLabelText(/Warp pin 1/);
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(handle, { clientX: 140, shiftKey: true });
    fireEvent.pointerUp(handle, { clientX: 140, shiftKey: true });
    const markers = appliedMarkerTick(services, doc);
    // 1728 / 120 = 14.4 → snaps to 14 × 120 = 1680.
    expect(markers[0].tick).toBe(1680);
  });

  it("a click without movement commits nothing", () => {
    const { doc } = docWithPin();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(domRect(400));
    const services = mockServices(doc);
    renderWithContext(<ArrangementPanel />, { services });
    const handle = screen.getByLabelText(/Warp pin 1/);
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerUp(handle);
    expect((services.store.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("Alt-click deletes the pin", () => {
    const { doc } = docWithPin();
    const services = mockServices(doc);
    renderWithContext(<ArrangementPanel />, { services });
    const handle = screen.getByLabelText(/Warp pin 1/);
    fireEvent.pointerDown(handle, { button: 0, altKey: true, clientX: 100 });
    const calls = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const next = (calls[calls.length - 1][0] as Command).execute(doc);
    expect(next.arrangement.audioClips![0].warpMarkers ?? []).toHaveLength(0);
  });
});
