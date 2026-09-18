import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { LoudnessHistory } from "../../src/ui/LoudnessHistory";
import { renderWithContext } from "../helpers";

describe("LoudnessHistory", () => {
  it("renders the canvas with the aria-label", () => {
    renderWithContext(<LoudnessHistory height={64} />);
    const canvas = screen.getByLabelText(/Loudness history/i) as HTMLCanvasElement;
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName.toLowerCase()).toBe("canvas");
  });

  it("renders with custom height and id props", () => {
    renderWithContext(<LoudnessHistory height={96} id="lh-1" />);
    const canvas = screen.getByLabelText(/Loudness history/i) as HTMLCanvasElement;
    expect(canvas).toBeInTheDocument();
    expect(canvas.style.height).toBe("96px");
  });

  it("renders without throwing for default props", () => {
    renderWithContext(<LoudnessHistory />);
    expect(screen.getByLabelText(/Loudness history/i)).toBeInTheDocument();
  });
});