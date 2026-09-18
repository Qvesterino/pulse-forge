import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FxEqPanel } from "../../src/ui/FxEqPanel";
import { mockServices, renderWithContext } from "../helpers";

const baseProps = {
  trackId: "track-1",
  fxId: "fx-1",
  params: { bandCount: 6 },
  onParam: vi.fn(),
  onApplyPreset: vi.fn(),
};

describe("FxEqPanel", () => {
  it("renders the PRISM multiband editor with a band-select group and preset select", () => {
    renderWithContext(<FxEqPanel {...baseProps} />, { services: mockServices() });
    expect(screen.getByLabelText("PRISM multiband editor")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Select band" })).toBeInTheDocument();
    expect(screen.getByLabelText("PRISM preset")).toBeInTheDocument();
  });

  it("renders one B{i} button per band, defaulting 6 bands", () => {
    renderWithContext(<FxEqPanel {...baseProps} />, { services: mockServices() });
    const b = screen.getAllByRole("button", { name: /^B\d$/ });
    expect(b).toHaveLength(6);
    // B1 should start out pressed (selectedBand defaults to 1).
    expect(screen.getByRole("button", { name: "B1" })).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking B3 switches the active band to 3", async () => {
    const user = userEvent.setup();
    renderWithContext(<FxEqPanel {...baseProps} />, { services: mockServices() });
    await user.click(screen.getByRole("button", { name: "B3" }));
    expect(screen.getByRole("button", { name: "B3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "B1" })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders the degraded banner when degraded=true", () => {
    renderWithContext(<FxEqPanel {...baseProps} degraded={true} />, { services: mockServices() });
    expect(screen.getByText(/AudioWorklet unavailable/)).toBeInTheDocument();
  });

  it("renders no degraded banner when degraded is false/undefined", () => {
    renderWithContext(<FxEqPanel {...baseProps} />, { services: mockServices() });
    expect(screen.queryByText(/AudioWorklet unavailable/)).not.toBeInTheDocument();
  });
});
