import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
// (userEvent removed — unused)
import { OzvenaPanel } from "../../src/ui/OzvenaPanel";
import { mockServices, renderWithContext } from "../helpers";

const baseProps = {
  params: { "reverb.enabled": 1 },
  onParam: vi.fn(),
  onApplyPatch: vi.fn(),
};

describe("OzvenaPanel", () => {
  it("renders the VØID reverb editor region with the engine-mix weights group", () => {
    renderWithContext(<OzvenaPanel {...baseProps} />, { services: mockServices() });
    expect(screen.getByLabelText("VØID reverb editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Engine mix")).toBeInTheDocument();
  });

  it("renders a blend-pad canvas with a slider role and Blend pad label", () => {
    renderWithContext(<OzvenaPanel {...baseProps} />, { services: mockServices() });
    expect(screen.getByLabelText("Blend pad")).toBeInTheDocument();
  });

  it("renders the Reverb assistant block", () => {
    renderWithContext(<OzvenaPanel {...baseProps} />, { services: mockServices() });
    expect(screen.getByLabelText("Reverb assistant")).toBeInTheDocument();
  });

  it("renders the degraded banner when degraded=true", () => {
    renderWithContext(<OzvenaPanel {...baseProps} degraded={true} />, { services: mockServices() });
    expect(screen.getByText(/AudioWorklet unavailable|1:1|bypass/i)).toBeInTheDocument();
  });
});
