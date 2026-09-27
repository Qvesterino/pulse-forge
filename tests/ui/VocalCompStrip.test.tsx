import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VocalCompStrip } from "../../src/ui/VocalCompStrip";
import type { CompPlan } from "../../src/vocal/comping";

/**
 * VOCAL COMP STRIP (UI wiring) — the take picker's plan view: one cell per
 * bar colored by the winning take, honest gaps, per-take legend.
 */

function plan(overrides: Partial<CompPlan> = {}): CompPlan {
  return {
    segments: [
      { startBar: 0, endBar: 3, takeIndex: 0, score: 0.9 },
      { startBar: 4, endBar: 7, takeIndex: 1, score: 0.95 },
    ],
    sungBars: 8,
    perTakeBars: [4, 4],
    winner: 1,
    takesMeasured: 2,
    bars: 8,
    ...overrides,
  };
}

describe("VocalCompStrip", () => {
  it("renders one cell per bar with the winning take tagged", () => {
    const { container } = render(<VocalCompStrip plan={plan()} labels={["Take A", "Take B"]} />);
    const strip = screen.getByTestId("vocal-comp-strip");
    expect(strip).toBeDefined();
    const cells = container.querySelectorAll("[data-bar]");
    expect(cells).toHaveLength(8);
    expect(cells[0]!.getAttribute("data-take")).toBe("0");
    expect(cells[4]!.getAttribute("data-take")).toBe("1");
    // the title names the winning take per bar
    expect(cells[0]!.getAttribute("title")).toContain("Take A");
    expect(cells[4]!.getAttribute("title")).toContain("Take B");
  });

  it("renders unsung bars as honest gaps", () => {
    const gappy = plan({
      segments: [{ startBar: 0, endBar: 2, takeIndex: 0, score: 0.9 }],
      sungBars: 3,
      perTakeBars: [3, 0],
      winner: 0,
    });
    const { container } = render(<VocalCompStrip plan={gappy} labels={["Take A", "Take B"]} />);
    const gapCells = container.querySelectorAll('[data-take="gap"]');
    expect(gapCells).toHaveLength(5);
    expect(gapCells[0]!.getAttribute("title")).toContain("ticho");
  });

  it("shows the per-take legend with bar counts and sung coverage", () => {
    render(<VocalCompStrip plan={plan()} labels={["Take A", "Take B"]} />);
    expect(screen.getByText(/Take A · 4 taktov/)).toBeDefined();
    expect(screen.getByText(/Take B · 4 taktov/)).toBeDefined();
    expect(screen.getByText(/8\/8 spievaných/)).toBeDefined();
  });
});
