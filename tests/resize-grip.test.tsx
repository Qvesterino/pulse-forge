import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ResizeGrip } from "../src/ui/ResizeGrip";
import { getLayoutSnapshot, resetLayout } from "../src/ui/layout";
import { LAYOUT_BOUNDS, DEFAULT_LAYOUT_STATE } from "../src/shared/layout-data";

/**
 * Vlna C — the live resize grips.
 *
 * A grip is the kind of control that can look finished and still be broken: a
 * `cursor: col-resize` renders beautifully and moves nothing. These tests
 * therefore assert on the STORE (what the user would actually see change) and
 * on the persisted state, not on styles.
 *
 * The dock grip (DockChrome.tsx) already proved the interaction contract:
 * drag, double-click to reset, arrows when focused. These pin that the shared
 * component keeps the same promise for the regions it now drives.
 */

describe("ResizeGrip · drag", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it("widens the inspector when the right edge is dragged LEFT", () => {
    const before = getLayoutSnapshot().inspectorWidth;
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");

    fireEvent.pointerDown(grip, { clientX: 1000 });
    // Dragging left widens the right-hand column — the inversion users expect.
    act(() => fireEvent.pointerMove(window, { clientX: 960 }));
    act(() => fireEvent.pointerUp(window));

    expect(getLayoutSnapshot().inspectorWidth).toBe(before + 40);
  });

  it("clamps at the bounds — a fling cannot hide the inspector or eat the sequencer", () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");

    fireEvent.pointerDown(grip, { clientX: 1000 });
    act(() => fireEvent.pointerMove(window, { clientX: -5000 }));
    act(() => fireEvent.pointerUp(window));
    expect(getLayoutSnapshot().inspectorWidth).toBe(LAYOUT_BOUNDS.inspectorWidth.max);

    fireEvent.pointerDown(grip, { clientX: 0 });
    act(() => fireEvent.pointerMove(window, { clientX: 5000 }));
    act(() => fireEvent.pointerUp(window));
    expect(getLayoutSnapshot().inspectorWidth).toBe(LAYOUT_BOUNDS.inspectorWidth.min);
  });

  it("persists on RELEASE, never per pointermove", () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    fireEvent.pointerDown(grip, { clientX: 500 });
    act(() => fireEvent.pointerMove(window, { clientX: 460 }));
    // Mid-drag the store must NOT be written: applyLayoutToDocument re-applies
    // every var + class + zoom on each write, and a 120 Hz mouse would do that
    // 120 times a second on the thread that renders the DAW — the exact hazard
    // the dock grip's debounce exists to avoid.
    expect(setItem.mock.calls.filter(([k]) => k === "pf-layout-v1")).toHaveLength(0);
    // The preview still tracks the pointer, so the edge never feels laggy.
    expect(Number(grip.getAttribute("aria-valuenow"))).toBe(320);

    act(() => fireEvent.pointerUp(window));
    const stored = JSON.parse(localStorage.getItem("pf-layout-v1")!);
    expect(stored.inspectorWidth).toBe(320);
    setItem.mockRestore();
  });

  it("stops following the pointer after pointerup (no runaway resize)", () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");
    fireEvent.pointerDown(grip, { clientX: 500 });
    act(() => fireEvent.pointerMove(window, { clientX: 480 }));
    act(() => fireEvent.pointerUp(window));
    const settled = getLayoutSnapshot().inspectorWidth;
    // A move after release must be inert — the listener is removed, so the
    // committed value stays put instead of chasing a stray pointer event.
    act(() => fireEvent.pointerMove(window, { clientX: 300 }));
    expect(getLayoutSnapshot().inspectorWidth).toBe(settled);
  });
});

describe("ResizeGrip · keyboard + reset", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it("arrow keys step the width, with a larger step when Shift is held", () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");
    const before = getLayoutSnapshot().inspectorWidth;

    // ArrowLeft moves the boundary left, which GROWS the right-hand column.
    fireEvent.keyDown(grip, { key: "ArrowLeft" });
    expect(getLayoutSnapshot().inspectorWidth).toBe(before + 16);

    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(getLayoutSnapshot().inspectorWidth).toBe(before);

    fireEvent.keyDown(grip, { key: "ArrowLeft", shiftKey: true });
    expect(getLayoutSnapshot().inspectorWidth).toBe(before + 48);
  });

  it("Enter resets to the layout default — read from DEFAULT_LAYOUT_STATE, not a literal", () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");
    act(() => fireEvent.keyDown(grip, { key: "ArrowLeft" }));
    act(() => fireEvent.keyDown(grip, { key: "ArrowLeft" }));
    expect(getLayoutSnapshot().inspectorWidth).not.toBe(DEFAULT_LAYOUT_STATE.inspectorWidth);

    act(() => fireEvent.keyDown(grip, { key: "Enter" }));
    expect(getLayoutSnapshot().inspectorWidth).toBe(DEFAULT_LAYOUT_STATE.inspectorWidth);
  });

  it("double-click also resets", () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");
    act(() => fireEvent.keyDown(grip, { key: "ArrowLeft" }));
    fireEvent.doubleClick(grip);
    expect(getLayoutSnapshot().inspectorWidth).toBe(DEFAULT_LAYOUT_STATE.inspectorWidth);
  });

  it("exposes the value to assistive tech", () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");
    expect(grip).toHaveAttribute("role", "separator");
    expect(Number(grip.getAttribute("aria-valuenow"))).toBe(DEFAULT_LAYOUT_STATE.inspectorWidth);
  });
});

describe("ResizeGrip · the split ratio", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it("dragging the divider left gives slot A more room (direct, not inverted)", () => {
    render(<ResizeGrip region="dockSplitRatio" ariaLabel="Resize dock split" title="t" />);
    const grip = screen.getByLabelText("Resize dock split");
    const before = getLayoutSnapshot().dockSplitRatio;

    fireEvent.pointerDown(grip, { clientX: 400 });
    act(() => fireEvent.pointerMove(window, { clientX: 300 }));
    act(() => fireEvent.pointerUp(window));

    // Slot A is on the left: moving the divider left GROWS slot A.
    expect(getLayoutSnapshot().dockSplitRatio).toBeGreaterThan(before);
  });

  it("keeps the ratio inside its band", () => {
    render(<ResizeGrip region="dockSplitRatio" ariaLabel="Resize dock split" title="t" />);
    const grip = screen.getByLabelText("Resize dock split");
    fireEvent.pointerDown(grip, { clientX: 400 });
    act(() => fireEvent.pointerMove(window, { clientX: -9000 }));
    act(() => fireEvent.pointerUp(window));
    expect(getLayoutSnapshot().dockSplitRatio).toBe(LAYOUT_BOUNDS.dockSplitRatio.max);
  });
});

describe("ResizeGrip · a change from elsewhere reaches the grip", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it("the grip reflects an external change instead of showing a stale width", async () => {
    render(<ResizeGrip region="inspectorWidth" ariaLabel="Resize inspector" title="t" />);
    const grip = screen.getByLabelText("Resize inspector");
    // A PFLYT1 install, a reset, or another window all write the store directly.
    const { setLayout } = await import("../src/ui/layout");
    await act(async () => {
      setLayout({ inspectorWidth: 360 });
    });
    expect(Number(grip.getAttribute("aria-valuenow"))).toBe(360);
  });
});

describe("ResizeGrip · wiring", () => {
  const app = readFileSync(join(__dirname, "../src/ui/App.tsx"), "utf8");
  const css = readFileSync(join(__dirname, "../src/styles/24-layout-tokens.css"), "utf8");

  it("App mounts a grip for the inspector and for the dock split", () => {
    expect(app).toContain('region="inspectorWidth"');
    expect(app).toContain('region="dockSplitRatio"');
  });

  it("the inspector grip is an OVERLAY, not a grid item", () => {
    // A third grid cell would change the `minmax(0,1fr)` arithmetic and shift
    // the sequencer's computed width. The grip must not participate.
    expect(css).toMatch(/\.resize-grip\s*\{[^}]*position:\s*absolute/);
    expect(css).toContain("position: relative");
  });

  it("the grip is draggable, not just styled as if it were", () => {
    expect(css).toMatch(/cursor:\s*col-resize/);
    // touch-action keeps a drag from scrolling the page under the pointer.
    expect(css).toMatch(/touch-action:\s*none/);
  });

  it("hides the inspector grip below the 860px row-switch, where it is meaningless", () => {
    expect(css).toMatch(/@media \(max-width: 860px\)[\s\S]*\.resize-grip--x[\s\S]*display:\s*none/);
  });

  it("the split ratio drives the slot flex ratio", () => {
    expect(css).toContain("var(--dock-split-ratio");
  });
});