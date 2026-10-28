import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TsarPanel } from "../../src/ui/TsarPanel";
import { renderWithContext, mockServices } from "../helpers";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { createInstrumentTrackModel } from "../../src/project-model/schema";
import type { InstrumentTrack, ProjectDocument } from "../../src/project-model/types";
import { ORBIT_PRESETS } from "../../src/tsar/orbit";

/**
 * WAVE 5 — TSAR ORBIT IN THE PANEL (ADR 0074).
 *
 * The panel contract:
 *  - the surface is ONE 2-D pad that a mouse, a finger or the keyboard can
 *    drive, and it says where it stands;
 *  - a movement is ONE undoable step (the gesture is bracketed), and the
 *    panel never writes a parameter behind the command layer's back;
 *  - the recording lands in the PROJECT AUTOMATION, and the producer can
 *    take the original mapping back with one button.
 */

function tsarDoc(): ProjectDocument {
  const base = createProjectFromTemplate("empty");
  const track = createInstrumentTrackModel("tsar", 1);
  track.id = "tsar-orbit-ui";
  track.name = "TSAR Lead";
  return { ...base, tracks: [track] };
}

function trackOf(doc: ProjectDocument): InstrumentTrack {
  return doc.tracks.find((t): t is InstrumentTrack => t.id === "tsar-orbit-ui")!;
}

/** The pad's own rect — jsdom gives every element a zero-sized one. */
function stubPadRect(canvas: HTMLElement, size = 200) {
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: size,
    bottom: size,
    width: size,
    height: size,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("TsarPanel — ORBIT", () => {
  it("shows the surface, both axes and the mapping presets", () => {
    renderWithContext(<TsarPanel />, { services: mockServices(tsarDoc()) });

    const pad = screen.getByRole("slider", { name: "ORBIT performance surface" });
    expect(pad).toBeInTheDocument();
    // Both axes are named — a screen reader cannot describe a square with
    // one number.
    expect(pad.getAttribute("aria-valuetext")).toContain("X");
    expect(pad.getAttribute("aria-valuetext")).toContain("Y");
    expect(screen.getByLabelText("ORBIT X target parameter")).toBeInTheDocument();
    expect(screen.getByLabelText("ORBIT Y target parameter")).toBeInTheDocument();
    const presets = screen.getByRole("group", { name: "ORBIT mapping presets" });
    for (const preset of ORBIT_PRESETS) {
      expect(within(presets).getByRole("button", { name: preset.name })).toBeInTheDocument();
    }
  });

  it("the keyboard moves the surface — one command, both axes", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    const pad = screen.getByRole("slider", { name: "ORBIT performance surface" });
    pad.focus();
    await user.keyboard("{ArrowRight}");
    // Y starts at the TOP of its range (the patch's cutoff is open), so the
    // arrow that can move it is the one that closes the filter.
    await user.keyboard("{ArrowDown}");

    expect(executeSpy).toHaveBeenCalledTimes(2);
    const command = executeSpy.mock.calls[0]![0] as { type: string };
    expect(command.type).toBe("setInstrumentParams");
  });

  it("a gesture is bracketed — the whole drag is ONE undo entry", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const beginSpy = vi.spyOn(services.store, "beginUndoFrame");
    const endSpy = vi.spyOn(services.store, "endUndoFrame");
    renderWithContext(<TsarPanel />, { services });

    const pad = screen.getByRole("slider", { name: "ORBIT performance surface" });
    stubPadRect(pad);
    await user.pointer({ keys: "[MouseLeft>]", target: pad, coords: { clientX: 100, clientY: 50 } });
    await user.pointer({ keys: "[/MouseLeft]", target: pad });

    expect(beginSpy).toHaveBeenCalled();
    expect(endSpy).toHaveBeenCalled();
  });

  it("a pointer drag writes the axis values, not the raw positions", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    const pad = screen.getByRole("slider", { name: "ORBIT performance surface" });
    stubPadRect(pad);
    await user.pointer({ keys: "[MouseLeft>]", target: pad, coords: { clientX: 100, clientY: 50 } });

    const command = executeSpy.mock.calls[0]![0] as {
      type: string;
      execute: (doc: ProjectDocument) => ProjectDocument;
    };
    expect(command.type).toBe("setInstrumentParams");
    const next = command.execute(services.store.doc);
    const params = trackOf(next).params;
    // X is MORPH (0..1) at the middle of the pad, Y is the cutoff axis.
    expect(params.morph).toBeCloseTo(0.5, 2);
    expect(params.srcACutoff).toBeGreaterThan(200);
    expect(params.srcACutoff).toBeLessThan(12000);
  });

  it("re-assigning an axis is ONE command that installs the mapping", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    await user.selectOptions(screen.getByLabelText("ORBIT Y target parameter"), "srcAQ");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const command = executeSpy.mock.calls[0]![0] as { type: string };
    expect(command.type).toBe("setOrbitMapping");
  });

  it("a preset is one command, and RESTORE brings the original mapping back", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    await user.click(screen.getByRole("button", { name: ORBIT_PRESETS[2]!.name }));
    expect(executeSpy.mock.calls[0]![0]).toMatchObject({ type: "setOrbitMapping" });

    await user.click(screen.getByRole("button", { name: "RESTORE ORIGINAL" }));
    const restore = executeSpy.mock.calls.at(-1)![0] as { type: string };
    expect(restore.type).toBe("setOrbitMapping");
  });

  it("RECORD arms the recording, and the movement lands in the project automation", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    // The transport has to run — a recording samples the musical tick.
    vi.spyOn(services.transport, "playing", "get").mockReturnValue(true);
    vi.spyOn(services.transport, "position", "get").mockReturnValue(480);
    const executeSpy = vi.spyOn(services.store, "execute");
    renderWithContext(<TsarPanel />, { services });

    await user.click(screen.getByRole("button", { name: "RECORD" }));
    expect(screen.getByRole("button", { name: "RECORDING" })).toBeInTheDocument();

    const pad = screen.getByRole("slider", { name: "ORBIT performance surface" });
    stubPadRect(pad);
    await user.pointer({ keys: "[MouseLeft>]", target: pad, coords: { clientX: 100, clientY: 50 } });
    await user.pointer({ keys: "[/MouseLeft]", target: pad });

    const recorded = executeSpy.mock.calls
      .map((call) => call[0] as { type: string })
      .filter((c) => c.type === "recordOrbitPath");
    expect(recorded).toHaveLength(1);
  });

  it("the recording is refused with a reason when the transport is not running", async () => {
    const user = userEvent.setup();
    const services = mockServices(tsarDoc());
    renderWithContext(<TsarPanel />, { services });

    await user.click(screen.getByRole("button", { name: "RECORD" }));
    const pad = screen.getByRole("slider", { name: "ORBIT performance surface" });
    stubPadRect(pad);
    await user.pointer({ keys: "[MouseLeft>]", target: pad, coords: { clientX: 100, clientY: 50 } });
    await user.pointer({ keys: "[/MouseLeft]", target: pad });

    expect(screen.getByText(/transport must be running/u)).toBeInTheDocument();
  });

  it("an axis that cannot be heard says so, instead of moving numbers in silence", () => {
    renderWithContext(<TsarPanel />, { services: mockServices(tsarDoc()) });
    // The default patch has source B silent, so the global MORPH (which
    // needs both sources) is silent — and the panel says it.
    expect(screen.getByText(/X silent/u)).toBeInTheDocument();
  });
});
