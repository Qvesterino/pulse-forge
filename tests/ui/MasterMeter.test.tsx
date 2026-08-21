import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MasterMeter } from "../../src/ui/MasterMeter";
import { renderWithContext } from "../helpers";

describe("MasterMeter", () => {
  it("renders master meter group", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByRole("group", { name: /Master meter/ })).toBeInTheDocument();
  });

  it("shows L and R channel labels", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByText("L")).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("shows correlation meter label", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByText("×CORR")).toBeInTheDocument();
  });

  it("shows headroom label", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByText("HEAD")).toBeInTheDocument();
  });

  it("shows ceiling dB value", () => {
    renderWithContext(<MasterMeter />);
    // Default ceiling is -1
    expect(screen.getByText("-1.0 dB")).toBeInTheDocument();
  });
});
