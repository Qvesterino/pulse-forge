import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UltinaPanel } from "../../src/ui/UltinaPanel";
import { DEFAULT_MODULE_ORDER } from "../../src/effects/ultina-core/contracts/state";
import { mockServices, renderWithContext } from "../helpers";

const baseProps = {
  trackId: "track-1",
  fxId: "fx-1",
  params: { "comp.enabled": 1 },
  onParam: vi.fn(),
  onApplyPreset: vi.fn(),
  onApplyProposal: vi.fn(),
};

describe("UltinaPanel", () => {
  it("renders the module selector with one chip per module in DEFAULT_MODULE_ORDER", () => {
    renderWithContext(<UltinaPanel {...baseProps} />, { services: mockServices() });
    const chips = screen.getByRole("group", { name: "Select module" });
    expect(chips).toBeInTheDocument();
    expect(chips.querySelectorAll("button")).toHaveLength(DEFAULT_MODULE_ORDER.length);
  });

  it("defaults the selected module to the third row 'COMP' (the compander)", () => {
    renderWithContext(<UltinaPanel {...baseProps} />, { services: mockServices() });
    // selectedModule starts at "comp", so the COMP button is pressed.
    expect(screen.getByRole("button", { name: "COMP" })).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking EQ switches the selected module (EQ is in DEFAULT_MODULE_ORDER)", async () => {
    const user = userEvent.setup();
    renderWithContext(<UltinaPanel {...baseProps} params={{ "eq.enabled": 1 }} />, {
      services: mockServices(),
    });
    await user.click(screen.getByRole("button", { name: "EQ" }));
    expect(screen.getByRole("button", { name: "EQ" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "COMP" })).toHaveAttribute("aria-pressed", "false");
  });

  it("the ON/OFF toggle invokes onParam with `<module>.enabled` 0/1", async () => {
    const onParam = vi.fn();
    const user = userEvent.setup();
    // Start with comp turned OFF.
    renderWithContext(<UltinaPanel {...baseProps} params={{ "comp.enabled": 0 }} onParam={onParam} />, {
      services: mockServices(),
    });
    await user.click(screen.getByRole("button", { name: "OFF" }));
    expect(onParam).toHaveBeenCalledWith("comp.enabled", 1);
  });

  it("renders the degraded banner when the worklet is unavailable", () => {
    renderWithContext(<UltinaPanel {...baseProps} degraded={true} />, { services: mockServices() });
    expect(screen.getByText(/worklet|1:1/i)).toBeInTheDocument();
  });
});
