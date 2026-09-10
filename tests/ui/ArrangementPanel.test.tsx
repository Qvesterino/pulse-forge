import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { SelectionContext } from "../../src/ui/context";
import { renderWithContext, mockServices } from "../helpers";
import { SelectionStore } from "../../src/store/SelectionStore";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { ProjectDocument } from "../../src/project-model/types";

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

describe("ArrangementPanel — scene intensity lane", () => {
  // BAR_WIDTH=30 → pxPerTick = 30/1920 = 1/64. A 4-bar clip spans [0,120) px.
  const docWithCurve = (): ProjectDocument => {
    const doc = createProjectFromTemplate("house");
    const scene = doc.scenes[0];
    return {
      ...doc,
      scenes: [
        {
          ...scene,
          intensityCurve: [
            { offset: 480, value: 0.2 },
            { offset: 960, value: 1 },
          ],
        },
      ],
      arrangement: {
        ...doc.arrangement,
        clips: [{ id: "clip-1", sceneId: scene.id, startBar: 0, lengthBars: 4 }],
      },
    };
  };

  function renderWithCurve() {
    const rendered = renderWithContext(<ArrangementPanel />, { services: mockServices(docWithCurve()) });
    const lane = rendered.container.querySelector(".arr-intensity-lane") as HTMLElement;
    expect(lane).not.toBeNull();
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 800, 44));
    return rendered;
  }

  it("renders the curve of the scene clip with its points and the playhead readout", () => {
    const { container } = renderWithCurve();
    expect(container.querySelector(".arr-intensity-line")).not.toBeNull();
    expect(container.querySelectorAll(".arr-intensity-point")).toHaveLength(2);
    const lane = container.querySelector(".arr-intensity-lane") as HTMLElement;
    // Playhead at tick 0 clamps to the curve's first point value (0.2).
    expect(lane.dataset.playheadValue).toBe("0.20");
  });

  it("clicking empty lane space inside a clip adds a quantized point via setSceneIntensityCurve", () => {
    const { services, container } = renderWithCurve();
    const lane = container.querySelector(".arr-intensity-lane") as HTMLElement;
    // x=60px → tick 3840 (bar 2); y=22px → value 0.5.
    fireEvent.pointerDown(lane, { button: 0, clientX: 60, clientY: 22, pointerId: 1 });
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("setSceneIntensityCurve");
    // Execute against the store's own doc — scene ids are uid-random per
    // docWithCurve() call, and the delta is id-anchored.
    const next = command.execute(services.store.doc);
    const curve = next.scenes[0].intensityCurve;
    expect(curve).toContainEqual({ offset: 3840, value: 0.5 });
  });

  it("right-clicking a point deletes it from the scene curve", () => {
    const { services, container } = renderWithCurve();
    const lane = container.querySelector(".arr-intensity-lane") as HTMLElement;
    // Handle 1 sits at absTick 480 → x=7.5px; value 0.2 → y=35.2px.
    fireEvent.contextMenu(lane, { clientX: 9, clientY: 37 });
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("setSceneIntensityCurve");
    const next = command.execute(services.store.doc);
    expect(next.scenes[0].intensityCurve).toEqual([{ offset: 960, value: 1 }]);
  });

  it("dragging a point commits the moved value once", () => {
    const { services, container } = renderWithCurve();
    const lane = container.querySelector(".arr-intensity-lane") as HTMLElement;
    // Grab handle 1 (x 7.5, y 35.2), drag right one step and up to value 0.5.
    fireEvent.pointerDown(lane, { button: 0, clientX: 7.5, clientY: 35.2, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 67.5, clientY: 22, pointerId: 1 });
    fireEvent.pointerUp(lane, { pointerId: 1 });
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("setSceneIntensityCurve");
    const next = command.execute(services.store.doc);
    const curve = next.scenes[0].intensityCurve;
    // x=67.5px → tick 4320; y=22px → value 0.5. The dragged point (480) MOVED
    // — the command replaces it in place and the factory re-sorts the curve.
    expect(curve).toEqual([
      { offset: 960, value: 1 },
      { offset: 4320, value: 0.5 },
    ]);
  });

  it("the INT toggle hides and shows the lane", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { container } = renderWithCurve();
    expect(container.querySelector(".arr-intensity-lane")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "INT" }));
    expect(container.querySelector(".arr-intensity-lane")).toBeNull();
    await user.click(screen.getByRole("button", { name: "INT" }));
    expect(container.querySelector(".arr-intensity-lane")).not.toBeNull();
  });
});
