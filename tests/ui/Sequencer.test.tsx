import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Sequencer } from "../../src/ui/Sequencer";
import { renderWithContext } from "../helpers";

const defaultProps = {
  selectedPadId: "",
  selectedTrackId: "t1",
  onSelectTrack: vi.fn(),
  onSelectPad: vi.fn(),
  selectedNote: null,
  onSelectNote: vi.fn(),
  stepSelection: null,
  onSelectSteps: vi.fn(),
  scaleSnap: false,
};

describe("Sequencer", () => {
  it("renders step ruler", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    expect(screen.getByRole("row", { name: /Step ruler/ })).toBeInTheDocument();
  });

  it("renders step numbers in ruler", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders dots for non-beat steps", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    const dots = screen.getAllByText("·");
    expect(dots.length).toBeGreaterThan(0);
  });

  it("renders track header rows", () => {
    const { container } = renderWithContext(<Sequencer {...defaultProps} />);
    const rows = container.querySelectorAll(".track-header-row");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("has step sequencer aria label", () => {
    renderWithContext(<Sequencer {...defaultProps} />);
    expect(screen.getByRole("region", { name: /Step Sequencer/ })).toBeInTheDocument();
  });
});
