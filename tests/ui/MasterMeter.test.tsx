import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MasterMeter, MasterStereoMeters } from "../../src/ui/MasterMeter";
import { renderWithContext } from "../helpers";

describe("MasterMeter", () => {
  it("renders master meter group", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByRole("group", { name: /Master meter/ })).toBeInTheDocument();
  });

  it("shows the buss-glue gain reduction separately", () => {
    renderWithContext(<MasterMeter />);
    expect(screen.getByText(/GLUE 0\.0 dB/)).toBeInTheDocument();
  });
});

describe("MasterStereoMeters", () => {
  it("renders the stereo indicator group", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByRole("group", { name: /Master stereo indicators/ })).toBeInTheDocument();
  });

  it("shows L and R channel labels", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByText("L")).toBeInTheDocument();
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("shows correlation meter label", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByText("×CORR")).toBeInTheDocument();
  });

  it("shows headroom label", () => {
    renderWithContext(<MasterStereoMeters />);
    expect(screen.getByText("HEAD")).toBeInTheDocument();
  });

  it("shows ceiling dB value", () => {
    renderWithContext(<MasterStereoMeters />);
    // Default ceiling is -1
    expect(screen.getByText("-1.0 dB")).toBeInTheDocument();
  });
});
