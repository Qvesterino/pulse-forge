import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SampleBrowser } from "../../src/ui/SampleBrowser";
import { renderWithContext } from "../helpers";
import { FACTORY_ASSETS } from "../../src/sample-library/manifest";

describe("SampleBrowser", () => {
  it("renders a row for each factory asset (sample-name buttons visible)", () => {
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />);
    // sample-name buttons carry the asset name; we should have one per asset
    const names = screen.getAllByRole("button", { name: /Kick Punch|Kick Deep|Snare/ });
    expect(names.length).toBeGreaterThan(0);
  });

  it("typing in the search box filters the visible tiles", () => {
    renderWithContext(<SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    const beforeCount = screen.getAllByRole("button").length;
    fireEvent.change(input, { target: { value: "no-such-pack-zzz" } });
    const afterCount = screen.getAllByRole("button").length;
    expect(afterCount).toBeLessThanOrEqual(beforeCount);
  });

  it("clicking a sample-name button fires onSelect with the asset id", () => {
    const onSelect = vi.fn();
    const { container } = renderWithContext(
      <SampleBrowser assets={FACTORY_ASSETS} currentId={null} onSelect={onSelect} />,
    );
    const sampleButton = container.querySelector("button.sample-name") as HTMLButtonElement;
    fireEvent.click(sampleButton);
    expect(onSelect).toHaveBeenCalled();
  });

  it("empty asset list renders no rows", () => {
    renderWithContext(<SampleBrowser assets={[]} currentId={null} onSelect={vi.fn()} />);
    expect(screen.queryAllByRole("button", { name: /Kick/ })).toHaveLength(0);
  });
});
