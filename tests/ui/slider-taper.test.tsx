import { describe, expect, it } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { Slider } from "../../src/ui/controls";
import { renderWithContext, mockServices } from "../helpers";

/**
 * Slider taper gestures (the math itself is pinned in
 * tests/slider-taper.test.ts).
 */
describe("Slider taper behavior", () => {
  function renderLogSlider(onCommit: (v: number) => void) {
    renderWithContext(
      <Slider label="CUTOFF" value={9000} min={20} max={20000} defaultValue={9000} taper="log" onCommit={onCommit} />,
      { services: mockServices() },
    );
    const track = screen.getByRole("slider", { name: "CUTOFF" });
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 200, top: 0, height: 10, right: 200, bottom: 10, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    return track;
  }

  it("mid-track drag commits the geometric mean on log taper", () => {
    const committed: number[] = [];
    const track = renderLogSlider((v) => committed.push(v));
    fireEvent.pointerDown(track, { clientX: 100, button: 0 });
    fireEvent.pointerUp(track);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toBeCloseTo(Math.sqrt(20 * 20000), 3);
  });

  it("fill position follows the log ratio, not the linear one", () => {
    // 9000 Hz on 20–20000 log ≈ 89% (musically near the top); linear math
    // would paint 45% and lie about the knob's travel.
    const committed: number[] = [];
    renderLogSlider((v) => committed.push(v));
    const fill = document.querySelector(".slider-fill") as HTMLElement;
    const width = Number.parseFloat(fill.style.width);
    expect(width).toBeGreaterThan(85);
    expect(width).toBeLessThan(93);
  });

  it("arrow keys step multiplicatively on log taper", () => {
    const committed: number[] = [];
    const track = renderLogSlider((v) => committed.push(v));
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(committed).toHaveLength(1);
    // Shown value is 9000: ratio +0.01 on 20–20000 log ≈ ×1.072.
    const ratio = Math.log(9000 / 20) / Math.log(20000 / 20);
    const expected = 20 * Math.pow(20000 / 20, ratio + 0.01);
    expect(committed[0]).toBeCloseTo(expected, 6);
    expect(committed[0] / 9000).toBeCloseTo(Math.pow(1000, 0.01), 4);
  });

  it("linear sliders keep the historical 1%-of-range behavior", () => {
    const committed: number[] = [];
    renderWithContext(
      <Slider label="GAIN" value={0.5} min={0} max={1} defaultValue={0.5} onCommit={(v) => committed.push(v)} />,
      { services: mockServices() },
    );
    fireEvent.keyDown(screen.getByRole("slider", { name: "GAIN" }), { key: "ArrowRight" });
    expect(committed[0]).toBeCloseTo(0.51, 8);
  });
});
