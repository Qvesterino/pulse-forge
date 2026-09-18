import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MidiPanel } from "../../src/ui/MidiPanel";
import { mockServices, renderWithContext } from "../helpers";

const baseProps = {
  selectedTrackId: "track-1",
  selectedNote: null,
  scaleSnap: false,
  onToggleScaleSnap: vi.fn(),
  onClearSelection: vi.fn(),
};

describe("MidiPanel", () => {
  it("renders the MIDI section header and tabs INPUT / CREATIVITY", () => {
    renderWithContext(<MidiPanel {...baseProps} />, { services: mockServices() });
    expect(screen.getByRole("heading", { name: "MIDI", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "INPUT" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "CREATIVITY" })).toBeInTheDocument();
  });

  it("INPUT tab is selected by default (aria-selected=true on INPUT)", () => {
    renderWithContext(<MidiPanel {...baseProps} />, { services: mockServices() });
    expect(screen.getByRole("tab", { name: "INPUT" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "CREATIVITY" })).toHaveAttribute("aria-selected", "false");
  });

  it("clicking CREATIVITY switches the active tab", async () => {
    const user = userEvent.setup();
    renderWithContext(<MidiPanel {...baseProps} />, { services: mockServices() });
    await user.click(screen.getByRole("tab", { name: "CREATIVITY" }));
    expect(screen.getByRole("tab", { name: "CREATIVITY" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "INPUT" })).toHaveAttribute("aria-selected", "false");
  });

  it("the MIDI enable toggle runs a setMidiConfig command via the store", async () => {
    const services = mockServices();
    const execute = vi.spyOn(services.store, "execute");
    const user = userEvent.setup();
    renderWithContext(<MidiPanel {...baseProps} />, { services });
    // aria-pressed toggle button is labelled "MIDI OFF" when disabled.
    await user.click(screen.getByRole("button", { name: /MIDI OFF/i }));
    expect(execute).toHaveBeenCalled();
  });
});
