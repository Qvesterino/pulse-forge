import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Slider } from "../../src/ui/controls";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit 04 remaining-risk fixes:
 *  1. Mixer faders preview LIVE during the drag (engine preview API) —
 *     onPreview/onCancel wired on gain/pan/return/master.
 *  2. Double-click reset no longer commits the clicked position on the
 *     second zero-movement click — the dblclick's default-commit is the
 *     only write (first click still commits: click-to-set stays intact).
 */

function renderSlider(overrides: Partial<Parameters<typeof Slider>[0]> = {}) {
  const onCommit = vi.fn();
  const onPreview = vi.fn();
  const onCancel = vi.fn();
  const { container } = render(
    <Slider
      label="F"
      value={0.5}
      min={0}
      max={1}
      defaultValue={0.9}
      onCommit={onCommit}
      onPreview={onPreview}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  const track = container.querySelector('[role="slider"]') as HTMLElement;
  return { track, onCommit, onPreview, onCancel };
}

function click(track: HTMLElement) {
  // jsdom rects are zero → positionToValue resolves to min (0). No movement.
  fireEvent.pointerDown(track, { button: 0, clientX: 0, clientY: 0, pointerType: "mouse" });
  fireEvent.pointerUp(track, { clientX: 0, clientY: 0 });
}

describe("Slider — double-click reset suppression (audit 04)", () => {
  it("first zero-movement click commits (click-to-set intact)", () => {
    const { track, onCommit, onCancel } = renderSlider({ onPreview: vi.fn() });
    click(track);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("the second click of a double-click skips its commit and restores via onCancel", () => {
    const { track, onCommit, onCancel } = renderSlider({ onPreview: vi.fn() });
    click(track);
    click(track); // within 300 ms → part of the double-click
    expect(onCommit, "only the FIRST click commits; dblclick owns the reset").toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a third click commits again (suppression is not sticky)", () => {
    const { track, onCommit } = renderSlider({ onPreview: vi.fn() });
    click(track);
    click(track);
    click(track); // timestamp was reset by the skipped second click
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("a moved drag always commits immediately, even right after a click", () => {
    const { track, onCommit } = renderSlider({ onPreview: vi.fn() });
    click(track);
    fireEvent.pointerDown(track, { button: 0, clientX: 0, clientY: 0, pointerType: "mouse" });
    fireEvent.pointerMove(track, { clientX: 40, clientY: 0 }); // > 4 px slop
    fireEvent.pointerUp(track, { clientX: 40, clientY: 0 });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("the built-in dblclick reset commits the default (one write after suppression)", () => {
    const { track, onCommit } = renderSlider({ onPreview: vi.fn() });
    click(track);
    click(track);
    fireEvent.doubleClick(track);
    expect(onCommit).toHaveBeenLastCalledWith(0.9);
  });
});

describe("Mixer — live fader preview wiring (audit 04 #6)", () => {
  it("engine exposes the preview API and the mixer routes onPreview to it", () => {
    const engine = readFileSync(resolve(process.cwd(), "src/audio-engine/AudioEngine.ts"), "utf8");
    for (const method of [
      "previewTrackGain(",
      "previewTrackPan(",
      "previewReturnGain(",
      "previewMasterGain(",
    ]) {
      expect(engine).toContain(method);
    }
    const mixer = readFileSync(resolve(process.cwd(), "src/ui/Mixer.tsx"), "utf8");
    expect(mixer.match(/onPreview=/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(mixer.match(/onCancel=/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(mixer).toContain("previewTrackGain(track.id, gain)");
    expect(mixer).toContain("previewReturnGain(ret.id, gain)");
    expect(mixer).toContain("previewMasterGain(masterGain)");
  });
});
