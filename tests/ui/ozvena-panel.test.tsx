import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OzvenaPanel } from "../../src/ui/OzvenaPanel";

/**
 * OzvenaPanel interaction contract:
 *  - the blend pad is keyboard-operable (arrows / PageUp/Down, shift = fine)
 *    and announces the full engine distribution via aria-valuetext,
 *  - the Reverb Assistant applies a DIFF-BASED patch: only fields the
 *    recommendation actually moves land in the patch — the user's engine
 *    toggles, MIX and everything not proposed survive the gesture.
 */

function renderPad(params: Record<string, number> = { "blendPad.x": 0.5, "blendPad.y": 0.5 }) {
  const onParam = vi.fn();
  const onApplyPatch = vi.fn();
  render(<OzvenaPanel params={params} onParam={onParam} onApplyPatch={onApplyPatch} />);
  const pad = screen.getByRole("slider", { name: /blend pad/i });
  return { pad, onParam, onApplyPatch };
}

describe("OzvenaPanel blend pad — keyboard accessibility", () => {
  it("is focusable and moves X/Y with arrow keys", () => {
    const { pad, onParam } = renderPad();
    expect(pad).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(pad, { key: "ArrowLeft" });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0.45);
    expect(onParam).toHaveBeenCalledWith("blendPad.y", 0.5);
    onParam.mockClear();
    fireEvent.keyDown(pad, { key: "ArrowUp" });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0.5);
    expect(onParam).toHaveBeenCalledWith("blendPad.y", 0.55);
  });

  it("shift+arrow is a fine step, PageUp/Down a coarse Y step", () => {
    const { pad, onParam } = renderPad();
    fireEvent.keyDown(pad, { key: "ArrowRight", shiftKey: true });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0.51);
    onParam.mockClear();
    fireEvent.keyDown(pad, { key: "PageUp" });
    expect(onParam).toHaveBeenCalledWith("blendPad.y", 0.75);
  });

  it("clamps at the pad edges (no spurious calls at the boundary)", () => {
    const { pad, onParam } = renderPad({ "blendPad.x": 0, "blendPad.y": 1 });
    fireEvent.keyDown(pad, { key: "ArrowLeft" });
    fireEvent.keyDown(pad, { key: "ArrowUp" });
    expect(onParam).not.toHaveBeenCalled();
  });

  it("announces the engine distribution to screen readers", () => {
    const { pad } = renderPad();
    // x=y=0.5 → barycentric weights e1≈21%, e2≈21%, e3≈58%.
    expect(pad).toHaveAttribute("aria-valuetext", "E1 21%, E2 21%, E3 58%");
  });

  it("exposes numeric X/Y fields that write typed percentages", () => {
    const { onParam } = renderPad();
    const x = screen.getByRole("spinbutton", { name: "Blend pad X position percent" });
    const y = screen.getByRole("spinbutton", { name: "Blend pad Y position percent" });
    expect(x).toHaveValue(50);
    expect(y).toHaveValue(50);

    fireEvent.change(x, { target: { value: "80" } });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0.8);
    onParam.mockClear();
    fireEvent.change(y, { target: { value: "25" } });
    expect(onParam).toHaveBeenCalledWith("blendPad.y", 0.25);
  });

  it("clamps typed pad percentages to 0..100", () => {
    const { onParam } = renderPad();
    const x = screen.getByRole("spinbutton", { name: "Blend pad X position percent" });
    fireEvent.change(x, { target: { value: "180" } });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 1);
    onParam.mockClear();
    fireEvent.change(x, { target: { value: "-40" } });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0);
  });
});

describe("OzvenaPanel Reverb Assistant — diff-based patch", () => {
  it("ASSIST proposes only changed fields and preserves user config", () => {
    const userParams: Record<string, number> = {
      "blendPad.x": 0.2,
      "blendPad.y": 0.3,
      "engines.e2.enabled": 0, // user muted the plate — must survive
      "global.dryWet": 40, // user's mix — must survive
      "global.inputGainDb": -3,
      "global.outputGainDb": 2,
      "global.levelDb": -1,
    };
    const onApplyPatch = vi.fn();
    render(<OzvenaPanel params={userParams} onParam={vi.fn()} onApplyPatch={onApplyPatch} />);
    fireEvent.click(screen.getByRole("button", { name: /assist/i }));

    expect(onApplyPatch).toHaveBeenCalledTimes(1);
    const [, patch] = onApplyPatch.mock.calls[0] as [string, Record<string, number>];

    // The proposal itself is present… (at the default style/size sliders
    // the recommendation maps blendPad to exactly the default 0.5/0.5, so
    // the diff drops it — engine times/EQ/pre-delay are the moved fields.)
    expect(patch["engines.e1.time"]).toBeDefined();
    expect(patch["engines.e3.time"]).toBeDefined();
    expect(patch["preEq.enabled"]).toBe(1);
    expect(patch["preDelay.ms"]).toBeDefined();
    // …but everything the user owns is untouched.
    expect(patch["engines.e2.enabled"]).toBeUndefined();
    expect(patch["global.dryWet"]).toBeUndefined();
    expect(patch["global.inputGainDb"]).toBeUndefined();
    expect(patch["global.outputGainDb"]).toBeUndefined();
    expect(patch["global.levelDb"]).toBeUndefined();
  });
});
