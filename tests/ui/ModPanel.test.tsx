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

  it("renders LFO section", () => {
    renderWithContext(<ModPanel />);
    expect(screen.getByText("LFO")).toBeInTheDocument();
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
