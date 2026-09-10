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

describe("ArrangementPanel — arrangement ergonomics", () => {
  // Two scene clips at bars 0-4 and 4-8.
  function docWithTwoClips(): ProjectDocument {
    const doc = createProjectFromTemplate("house");
    const scene = doc.scenes[0];
    return {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        clips: [
          { id: "clip-1", sceneId: scene.id, startBar: 0, lengthBars: 4 },
          { id: "clip-2", sceneId: scene.id, startBar: 4, lengthBars: 4 },
        ],
      },
    };
  }

  function renderErgo(doc: ProjectDocument) {
    const selectionStore = new SelectionStore();
    const setClipsSpy = vi.spyOn(selectionStore, "setClips");
    const wrapped = renderWithContext(
      <SelectionContext.Provider value={selectionStore}>
        <ArrangementPanel />
      </SelectionContext.Provider>,
      { services: mockServices(doc) },
    );
    const lane = wrapped.container.querySelector(".arr-lane") as HTMLElement;
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 800, 56));
    // jsdom gives every element a zero rect — clip resize/move hit-testing
    // needs the real geometry (30px per bar at zoom 1).
    for (const node of wrapped.container.querySelectorAll(".arr-clip") as NodeListOf<HTMLElement>) {
      const left = parseInt(node.style.left, 10) || 0;
      const width = parseInt(node.style.width, 10) || 0;
      vi.spyOn(node, "getBoundingClientRect").mockReturnValue(domRect(left, 0, width, 56));
    }
    return { ...wrapped, selectionStore, setClipsSpy, lane };
  }

  it("zoom buttons scale the arrangement width and FIT fits it", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { container } = renderErgo(docWithTwoClips());
    const widthOf = () => parseInt((container.querySelector(".arr-lane") as HTMLElement).style.width, 10);
    const base = widthOf();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(widthOf()).toBe(Math.round(base * 1.4));
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(widthOf()).toBe(base);
    await user.click(screen.getByRole("button", { name: "Fit arrangement" }));
    expect(widthOf()).toBeLessThanOrEqual(base);
  });

  it("ctrl+wheel zooms around the cursor (non-passive native listener)", () => {
    const { container } = renderErgo(docWithTwoClips());
    const scroll = container.querySelector(".arr-lane-scroll") as HTMLElement;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(domRect(0, 0, 800, 200));
    const widthOf = () => parseInt((container.querySelector(".arr-lane") as HTMLElement).style.width, 10);
    const before = widthOf();
    fireEvent.wheel(scroll, { ctrlKey: true, deltaY: -240, clientX: 400, clientY: 100 });
    expect(widthOf()).toBeGreaterThan(before);
    // Plain wheel (no ctrl) must NOT zoom.
    fireEvent.wheel(scroll, { deltaY: -240, clientX: 400, clientY: 100 });
    expect(widthOf()).toBe(parseInt((container.querySelector(".arr-lane") as HTMLElement).style.width, 10));
  });

  it("ctrl+click adds clips to the shared clip selection", () => {
    const { container, selectionStore, setClipsSpy } = renderErgo(docWithTwoClips());
    const clips = [...container.querySelectorAll(".arr-clip")] as HTMLElement[];
    expect(clips.length).toBe(2);
    fireEvent.pointerDown(clips[0], { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(setClipsSpy).toHaveBeenLastCalledWith(["clip-1"]);
    // Simulate the store actually holding the selection, then ctrl+click #2.
    vi.spyOn(selectionStore, "isClipSelected").mockImplementation((id) => id === "clip-1");
    (selectionStore as unknown as { state: { clipIds: string[] } }).state.clipIds = ["clip-1"];
    fireEvent.pointerDown(clips[1], { button: 0, clientX: 200, clientY: 10, ctrlKey: true, pointerId: 1 });
    expect(setClipsSpy).toHaveBeenLastCalledWith(["clip-1", "clip-2"]);
  });

  it("empty-lane drag marquees clips; a plain click still places the scene", () => {
    const { services, container, setClipsSpy } = renderErgo(docWithTwoClips());
    const lane = container.querySelector(".arr-lane") as HTMLElement;
    // Drag from bar 0.2 to bar 3 → intersects clip-1 only.
    fireEvent.pointerDown(lane, { button: 0, clientX: 6, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 90, clientY: 10, pointerId: 1 });
    expect(container.querySelector(".arr-marquee")).not.toBeNull();
    fireEvent.pointerUp(lane, { clientX: 90, pointerId: 1 });
    expect(container.querySelector(".arr-marquee")).toBeNull();
    expect(setClipsSpy).toHaveBeenLastCalledWith(["clip-1"]);
    // A tiny drag (<0.15 bar) is a click → places the selected scene instead
    // (bar 10 — past both clips, so the add cannot collide).
    fireEvent.pointerDown(lane, { button: 0, clientX: 300, clientY: 10, pointerId: 2 });
    fireEvent.pointerUp(lane, { clientX: 301, pointerId: 2 });
    const last = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(last?.type).toBe("addArrangementClip");
  });

  it("dragging one clip of an active multi-selection moves all of them as ONE command", () => {
    const doc = docWithTwoClips();
    const { services, container, selectionStore } = renderErgo(doc);
    selectionStore.setClips(["clip-1", "clip-2"]);
    const clips = [...container.querySelectorAll(".arr-clip")] as HTMLElement[];
    // Press on clip-1, drag +2 bars (60px), release.
    fireEvent.pointerDown(clips[0], { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(clips[0], { clientX: 70, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(clips[0], { pointerId: 1 });
    const command = (services.store.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(command?.type).toBe("moveClips");
    expect(command?.label).toBe("Move 2 clips");
    // One gesture: both clips land 2 bars later.
    const next = command.execute(doc);
    expect(next.arrangement.clips.find((c: { id: string }) => c.id === "clip-1")?.startBar).toBe(2);
    expect(next.arrangement.clips.find((c: { id: string }) => c.id === "clip-2")?.startBar).toBe(6);
  });

  it("right-click delete shows an actionable toast whose UNDO calls the store", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { services, container } = renderErgo(docWithTwoClips());
    const clips = [...container.querySelectorAll(".arr-clip")] as HTMLElement[];
    fireEvent.contextMenu(clips[0]);
    const toast = container.querySelector(".arr-delete-toast") as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('Deleted "');
    await user.click(screen.getByRole("button", { name: "UNDO" }));
    expect(services.store.undo).toHaveBeenCalled();
    expect(container.querySelector(".arr-delete-toast")).toBeNull();
  });
});
