import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ModPanel } from "../../src/ui/ModPanel";
import { renderWithContext } from "../helpers";

describe("ModPanel", () => {
  it("renders with correct aria label", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByRole("region", { name: /Automation, LFOs and macros/ })).toBeInTheDocument();
  });

  it("renders AUTOMATION section", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByText("AUTOMATION")).toBeInTheDocument();
  });

  it("renders MODULATORS section (LFO / S&H / Step / Env Follower)", () => {
    const { container } = renderWithContext(<ModPanel />);
    expect(screen.getByText("MODULATORS")).toBeInTheDocument();
    // Kind picker groups all four modulator families per track (value-encoded).
    const picker = container.querySelector('select[aria-label="Add modulator"]');
    expect(picker).not.toBeNull();
    const values = [...(picker?.querySelectorAll("option") ?? [])].map((o) => o.value);
    expect(values.some((v) => v.startsWith("osc:"))).toBe(true);
    expect(values.some((v) => v.startsWith("random:"))).toBe(true);
    expect(values.some((v) => v.startsWith("step:"))).toBe(true);
    expect(values.some((v) => v.startsWith("envFollower:"))).toBe(true);
  });

  it("renders MACROS section", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByText("MACROS")).toBeInTheDocument();
  });

  it("renders SCENES section", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByText("SCENES")).toBeInTheDocument();
  });
});
