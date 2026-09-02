import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { SelectionContext } from "../../src/ui/context";
import { renderWithContext } from "../helpers";
import { SelectionStore } from "../../src/store/SelectionStore";

const domRect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

describe("ArrangementPanel", () => {
  it("renders SCENES heading", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("SCENES")).toBeInTheDocument();
  });

  it("shows + SCENE button", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("+ SCENE")).toBeInTheDocument();
  });

  it("calls createScene when + SCENE clicked", async () => {
    const { services } = renderWithContext(<ArrangementPanel />);
    const btn = screen.getByText("+ SCENE");
    const { click } = await import("@testing-library/user-event").then((m) => m.default.setup());
    await click(btn);
    expect(services.store.execute).toHaveBeenCalled();
  });

  it("has correct aria label", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByRole("region", { name: /Arrangement and scenes/ })).toBeInTheDocument();
  });

  it("ruler mode toggle exists", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("ARRANGEMENT")).toBeInTheDocument();
  });

  it("exposes capture and skeleton controls", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("CAPTURE")).toBeInTheDocument();
    expect(screen.getByText("BUILD SKELETON")).toBeInTheDocument();
    expect(screen.getByText("ROLE")).toBeInTheDocument();
  });

  it("exposes the source rail, quantize state and arrangement role flow", () => {
    renderWithContext(<ArrangementPanel />);
    expect(screen.getByText("SOURCE")).toBeInTheDocument();
    expect(screen.getByText("QUANTIZE")).toBeInTheDocument();
    expect(screen.getByLabelText("Arrangement role flow")).toBeInTheDocument();
  });

  it("starts capture from the arrangement toolbar", async () => {
    const { services } = renderWithContext(<ArrangementPanel />);
    const user = (await import("@testing-library/user-event")).default.setup();
    await user.click(screen.getByText("CAPTURE"));
    expect((services.capture as any).start).toHaveBeenCalledTimes(1);
  });

  it("interrupted ruler drag drops the in-progress time range", () => {
    const selectionStore = new SelectionStore();
    const setTimeRange = vi.spyOn(selectionStore, "setTimeRange");
    const { container } = renderWithContext(
      <SelectionContext.Provider value={selectionStore}>
        <ArrangementPanel />
      </SelectionContext.Provider>,
    );
    const ruler = container.querySelector(".arr-ruler") as HTMLElement;
    vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 800, 20));
    fireEvent.pointerDown(ruler, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: 300, pointerId: 1 });
    expect(setTimeRange).toHaveBeenLastCalledWith(expect.objectContaining({ fromTick: expect.any(Number) }));
    fireEvent.pointerCancel(ruler, { pointerId: 1 });
    expect(setTimeRange).toHaveBeenLastCalledWith(null);
    // A stale pointerup after the cancel must not seek or re-commit.
    expect(() => fireEvent.pointerUp(ruler, { clientX: 300, pointerId: 1 })).not.toThrow();
    expect(setTimeRange).toHaveBeenLastCalledWith(null);
  });
});
