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

    // Typing only drafts; the commit gesture (Enter / blur) is what writes.
    fireEvent.change(x, { target: { value: "80" } });
    expect(onParam).not.toHaveBeenCalled();
    fireEvent.keyDown(x, { key: "Enter" });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0.8);
    onParam.mockClear();
    fireEvent.change(y, { target: { value: "25" } });
    fireEvent.blur(y);
    expect(onParam).toHaveBeenCalledWith("blendPad.y", 0.25);
  });

  it("clamps typed pad percentages to 0..100", () => {
    const { onParam } = renderPad();
    const x = screen.getByRole("spinbutton", { name: "Blend pad X position percent" });
    fireEvent.change(x, { target: { value: "180" } });
    fireEvent.keyDown(x, { key: "Enter" });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 1);
    onParam.mockClear();
    fireEvent.change(x, { target: { value: "-40" } });
    fireEvent.keyDown(x, { key: "Enter" });
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0);
  });

  it("a typed value is ONE command, not one per keystroke (undo sanity)", () => {
    // Before the audit every keystroke executed a command, so typing "85"
    // created two history entries and a single Ctrl+Z snapped back to "8".
    const { onParam } = renderPad();
    const x = screen.getByRole("spinbutton", { name: "Blend pad X position percent" });
    fireEvent.change(x, { target: { value: "8" } });
    fireEvent.change(x, { target: { value: "85" } });
    expect(onParam).not.toHaveBeenCalled();
    fireEvent.keyDown(x, { key: "Enter" });
    expect(onParam).toHaveBeenCalledTimes(1);
    expect(onParam).toHaveBeenCalledWith("blendPad.x", 0.85);
  });

  it("Escape abandons the draft without writing", () => {
    const { onParam } = renderPad();
    const x = screen.getByRole("spinbutton", { name: "Blend pad X position percent" });
    fireEvent.change(x, { target: { value: "85" } });
    fireEvent.keyDown(x, { key: "Escape" });
    expect(onParam).not.toHaveBeenCalled();
    expect(x).toHaveValue(50);
  });

  it("a cleared field is a cancel, not 0% (Number('') would have been 0)", () => {
    const { onParam } = renderPad();
    const x = screen.getByRole("spinbutton", { name: "Blend pad X position percent" });
    fireEvent.change(x, { target: { value: "" } });
    fireEvent.blur(x);
    expect(onParam).not.toHaveBeenCalled();
  });

  it("brackets a pad drag and a key step in one gesture frame (one undo entry)", () => {
    const frames: string[] = [];
    const onParam = vi.fn();
    const onApplyPatch = vi.fn();
    let open = 0;
    render(
      <OzvenaPanel
        params={{ "blendPad.x": 0.5, "blendPad.y": 0.5 }}
        onParam={onParam}
        onApplyPatch={onApplyPatch}
        onGestureStart={() => {
          open += 1;
          frames.push("start");
        }}
        onGestureEnd={() => {
          open -= 1;
          frames.push("end");
        }}
      />,
    );
    const pad = screen.getByRole("slider", { name: /blend pad/i });
    // Keyboard: one press = one frame wrapping both X and Y writes.
    fireEvent.keyDown(pad, { key: "ArrowLeft" });
    expect(frames).toEqual(["start", "end"]);
    expect(onParam).toHaveBeenCalledTimes(2); // X and Y, inside ONE frame
    expect(open).toBe(0);

    // Drag: the frame stays open across every pointermove and closes on release.
    frames.length = 0;
    onParam.mockClear();
    fireEvent.pointerDown(pad, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(pad, { clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.pointerMove(pad, { clientX: 140, clientY: 80, pointerId: 1 });
    expect(frames).toEqual(["start"]); // still inside the gesture
    fireEvent.pointerUp(pad, { pointerId: 1 });
    expect(frames).toEqual(["start", "end"]);
    expect(open).toBe(0);
  });

  it("a cancelled drag still closes the frame (history is never left open)", () => {
    let open = 0;
    const onParam = vi.fn();
    render(
      <OzvenaPanel
        params={{ "blendPad.x": 0.5, "blendPad.y": 0.5 }}
        onParam={onParam}
        onApplyPatch={vi.fn()}
        onGestureStart={() => {
          open += 1;
        }}
        onGestureEnd={() => {
          open -= 1;
        }}
      />,
    );
    const pad = screen.getByRole("slider", { name: /blend pad/i });
    fireEvent.pointerDown(pad, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerCancel(pad, { pointerId: 1 });
    expect(open).toBe(0);
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
