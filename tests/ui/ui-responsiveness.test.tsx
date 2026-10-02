import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { Slider, DragNumber } from "../../src/ui/controls";
import { useDockLayout, clampDockHeight, DOCK_MIN_HEIGHT, DOCK_MAX_HEIGHT } from "../../src/ui/dockLayout";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { createDefaultProject } from "../../src/project-model/schema";
import { addAudioClip } from "../../src/commands/commands";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";

/**
 * Audit 16 — UI responsiveness.
 *
 * Every test here targets a *responsiveness* property, not a visual one:
 * a drag must cost one commit, a resize must not write storage per event,
 * and a pointer gesture must not be dropped by a state read that lags a frame.
 */

const rect = (left = 0, width = 100) =>
  ({
    left,
    top: 0,
    width,
    height: 10,
    right: left + width,
    bottom: 10,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

const withRect = (el: Element, left = 0, width = 100) =>
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(left, width));

describe("audit16 · Slider drag commits the value under the release point", () => {
  it("commits the LAST pointer position across a multi-move drag", () => {
    const onCommit = vi.fn();
    render(<Slider label="Cutoff" value={0} min={0} max={1} defaultValue={0} onCommit={onCommit} />);
    const track = screen.getByRole("slider");
    withRect(track, 0, 100);

    fireEvent.pointerDown(track, { button: 0, clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 50, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 90, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });

    expect(onCommit).toHaveBeenCalledTimes(1);
    // 90px of a 100px track = 0.9. Anything lower means the release lost a move.
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.9, 5);
  });

  it("commits the release position when move + release land in ONE frame", () => {
    // The frame-budget case. `pointermove` is a CONTINUOUS event in React 18:
    // its setState is scheduled at ContinuousEventPriority and flushed from a
    // Scheduler macrotask, NOT synchronously at the end of the event. A fast
    // flick can therefore deliver `pointerup` (DISCRETE priority) while the
    // move's state is still uncommitted. `onPointerUp` then runs the handler
    // closure from the previous render. The whole gesture is dispatched inside
    // one act() to model "no frame boundary between the events".
    const onCommit = vi.fn();
    render(<Slider label="Cutoff" value={0} min={0} max={1} defaultValue={0} onCommit={onCommit} />);
    const track = screen.getByRole("slider");
    withRect(track, 0, 100);

    act(() => {
      fireEvent.pointerDown(track, { button: 0, clientX: 0, pointerId: 1 });
      fireEvent.pointerMove(track, { clientX: 90, pointerId: 1 });
      fireEvent.pointerUp(track, { pointerId: 1 });
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.9, 5);
  });

  it("does not commit a value the pointer never reached (stale-frame release)", () => {
    // The production shape of the same root cause: the press HAS committed
    // (pointerdown is discrete, React flushes it), but the final move has not.
    // The release handler closure therefore still holds the press-time value.
    const onCommit = vi.fn();
    render(<Slider label="Cutoff" value={0} min={0} max={1} defaultValue={0} onCommit={onCommit} />);
    const track = screen.getByRole("slider");
    withRect(track, 0, 100);

    fireEvent.pointerDown(track, { button: 0, clientX: 0, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(track, { clientX: 90, pointerId: 1 });
      fireEvent.pointerUp(track, { pointerId: 1 });
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.9, 5);
  });

  it("a zero-movement click still commits the clicked position (click-to-set)", () => {
    const onCommit = vi.fn();
    render(<Slider label="Cutoff" value={0} min={0} max={1} defaultValue={0} onCommit={onCommit} />);
    const track = screen.getByRole("slider");
    withRect(track, 0, 100);

    fireEvent.pointerDown(track, { button: 0, clientX: 30, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(0.3, 5);
  });
});

describe("audit16 · DragNumber drag commits the value under the release point", () => {
  // 0..100 range: sensitivity 0.4/px over a 50 px drag moves 20 units, so the
  // test measures the drag arithmetic instead of saturating against max.
  it("commits the LAST pointer position across a multi-move drag", () => {
    const onCommit = vi.fn();
    render(<DragNumber label="Humanize" value={0} min={0} max={100} defaultValue={0} onCommit={onCommit} />);
    const field = screen.getByRole("spinbutton");

    fireEvent.pointerDown(field, { button: 0, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(field, { clientY: 180, pointerId: 1 });
    fireEvent.pointerMove(field, { clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(field, { pointerId: 1 });

    expect(onCommit).toHaveBeenCalledTimes(1);
    // (200 - 150) * 0.4 = 20. A stale 8 means the release lost the last move.
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(20, 5);
  });

  it("commits the release position when move + release land in ONE frame", () => {
    const onCommit = vi.fn();
    render(<DragNumber label="Humanize" value={0} min={0} max={100} defaultValue={0} onCommit={onCommit} />);
    const field = screen.getByRole("spinbutton");

    act(() => {
      fireEvent.pointerDown(field, { button: 0, clientY: 200, pointerId: 1 });
      fireEvent.pointerMove(field, { clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(field, { pointerId: 1 });
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(20, 5);
  });

  it("does not commit a value the pointer never reached (stale-frame release)", () => {
    const onCommit = vi.fn();
    render(<DragNumber label="Humanize" value={0} min={0} max={100} defaultValue={0} onCommit={onCommit} />);
    const field = screen.getByRole("spinbutton");

    fireEvent.pointerDown(field, { button: 0, clientY: 200, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(field, { clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(field, { pointerId: 1 });
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(20, 5);
  });
});

describe("audit16 · dock resize does not block the main thread per pointermove", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    window.localStorage.removeItem("pf-dock-v1");
    let n = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(++n * 16);
      return n;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
    window.localStorage.removeItem("pf-dock-v1");
  });

  it("coalesces a burst of resize moves instead of one storage write per event", () => {
    // localStorage.setItem is SYNCHRONOUS and main-thread blocking. One per
    // pointermove during a dock drag means a 120 Hz mouse performs 120
    // serialising writes per second on the thread that renders the DAW.
    let latest = 0;
    const Probe = () => {
      const [dock, setDock] = useDockLayout(800);
      latest = dock.height;
      return (
        <div
          data-testid="handle"
          onPointerDown={() => {
            const startY = 400;
            const startHeight = dock.height;
            const onMove = (e: PointerEvent) =>
              setDock({ ...dock, height: clampDockHeight(startHeight + (startY - e.clientY), 800) });
            const done = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", done);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", done);
          }}
        />
      );
    };
    const { getByTestId } = render(<Probe />);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockClear();

    fireEvent.pointerDown(getByTestId("handle"), { button: 0, clientY: 400, pointerId: 1 });
    const begin = latest;
    for (let i = 1; i <= 40; i++) {
      fireEvent.pointerMove(window, { clientY: 400 - i, pointerId: 1 });
    }
    fireEvent.pointerUp(window, { pointerId: 1 });

    const writes = setItem.mock.calls.filter(([k]) => k === "pf-dock-v1").length;
    setItem.mockRestore();
    // The resize must still TRACK the pointer — no dropped moves.
    expect(latest).toBe(begin + 40);
    // ... but 40 moves must not become 40 blocking storage writes.
    expect(writes).toBeLessThanOrEqual(2);
  });

  it("persists the final height once the drag settles", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    let api: ((h: number) => void) | null = null;
    const Probe = () => {
      const [dock, setDock] = useDockLayout(800);
      api = (h: number) => setDock({ ...dock, height: h });
      return <div data-testid="d">{dock.height}</div>;
    };
    const { getByTestId } = render(<Probe />);
    act(() => api!(360));
    expect(getByTestId("d").textContent).toBe("360");
    // The write is debounced, so it has not happened yet — that IS the fix.
    expect(setItem.mock.calls.filter(([k]) => k === "pf-dock-v1").length).toBe(0);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260));
    });
    const writes = setItem.mock.calls.filter(([k]) => k === "pf-dock-v1");
    setItem.mockRestore();
    expect(writes.length).toBe(1);
    expect(JSON.parse(String(writes[0][1])).height).toBe(360);
  });

  it("flushes the pending write on unmount so a reload keeps the last size", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    let api: ((h: number) => void) | null = null;
    const Probe = () => {
      const [dock, setDock] = useDockLayout(800);
      api = (h: number) => setDock({ ...dock, height: h });
      return <div>{dock.height}</div>;
    };
    const { unmount } = render(<Probe />);
    act(() => api!(444));
    // Unmount inside the debounce window — the write must still land.
    unmount();
    const writes = setItem.mock.calls.filter(([k]) => k === "pf-dock-v1");
    setItem.mockRestore();
    expect(writes.length).toBe(1);
    expect(JSON.parse(String(writes[0][1])).height).toBe(444);
  });

  it("re-clamps the dock when the viewport ceiling shrinks", () => {
    // A dock sized on a 2000px-tall display (560px, the cap) must not survive
    // a shrink to a 600px window, where the ceiling is 420. The clamp only
    // ran at load time, so the dock kept 560px and starved the sequencer above.
    let maxInner = 2000 * 0.7;
    const Probe = () => {
      const [dock, setDock] = useDockLayout(maxInner);
      return (
        <>
          <div data-testid="h">{dock.height}</div>
          <button data-testid="grow" onClick={() => setDock({ ...dock, height: DOCK_MAX_HEIGHT })}>
            grow
          </button>
        </>
      );
    };
    const { getByTestId, rerender } = render(<Probe />);
    act(() => {
      getByTestId("grow").click();
    });
    expect(getByTestId("h").textContent).toBe(String(DOCK_MAX_HEIGHT));

    // The window shrinks: 600px tall -> 420px ceiling.
    maxInner = 600 * 0.7;
    rerender(<Probe />);
    expect(Number(getByTestId("h").textContent)).toBeLessThanOrEqual(Math.round(600 * 0.7));
  });
});

describe("audit16 · arrangement clip drag commits the bar under the release point", () => {
  const domRect = (left: number, width: number) =>
    ({
      left,
      top: 0,
      width,
      height: 40,
      right: left + width,
      bottom: 40,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  const renderArrangement = () => {
    const doc = createProjectFromTemplate("house");
    const project = new ProjectStore(doc);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(doc), store: project } as unknown as Services;
    render(
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(
          SelectionContext.Provider,
          { value: selectionStore },
          createElement(ArrangementPanel) as ReactElement,
        ),
      ),
    );
    const lane = document.querySelector(".arr-lane");
    if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRect(0, 2000));
    const clipEl = document.querySelector(".arr-clip")!;
    expect(clipEl).not.toBeNull();
    vi.spyOn(clipEl, "getBoundingClientRect").mockReturnValue(domRect(0, 100));
    // The panel renders clips in document order, so the first `.arr-clip`
    // element is `arrangement.clips[0]` (it carries no data-clip-id).
    return { project, clipId: project.doc.arrangement.clips[0].id };
  };

  const startBarOf = (project: ProjectStore, clipId: string) =>
    project.doc.arrangement.clips.find((c) => c.id === clipId)?.startBar;

  it("commits the LAST pointer position across a multi-move drag", () => {
    const { project, clipId } = renderArrangement();
    const clipEl = document.querySelector(".arr-clip")!;
    const before = startBarOf(project, clipId)!;

    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(clipEl, { clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(clipEl, { clientX: 440, pointerId: 1 });
    fireEvent.pointerUp(clipEl, { pointerId: 1 });

    // BASE_BAR_WIDTH is 30 at zoom 1: grab at floor(40/30)=1, release at
    // floor(440/30)=14, so the clip travels 13 bars.
    expect(startBarOf(project, clipId)).toBe(before + 13);
  });

  it("does not commit a bar the pointer never reached (stale-frame release)", () => {
    // Same root cause as the Slider: `pointerup` is DISCRETE and can run
    // before the final continuous-priority `pointermove` state has committed,
    // so a handler reading React state lands the clip short of where it was
    // released.
    const { project, clipId } = renderArrangement();
    const clipEl = document.querySelector(".arr-clip")!;
    const before = startBarOf(project, clipId)!;

    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(clipEl, { clientX: 440, pointerId: 1 });
      fireEvent.pointerUp(clipEl, { pointerId: 1 });
    });

    expect(startBarOf(project, clipId)).toBe(before + 13);
  });

  it("Escape mid-drag cancels AND leaves no stale position for the next drag", () => {
    // The cancel path must clear the ref as well as the state — a ref that
    // outlives the cancel would leak the old bar into the next release.
    const { project, clipId } = renderArrangement();
    const clipEl = document.querySelector(".arr-clip")!;
    const before = startBarOf(project, clipId)!;

    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(clipEl, { clientX: 240, pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    fireEvent.pointerUp(clipEl, { pointerId: 1 });
    expect(startBarOf(project, clipId)).toBe(before);

    // A second, shorter drag must land exactly where it was released.
    fireEvent.pointerDown(clipEl, { button: 0, clientX: 40, pointerId: 2 });
    fireEvent.pointerMove(clipEl, { clientX: 140, pointerId: 2 });
    fireEvent.pointerUp(clipEl, { pointerId: 2 });
    // floor(140/30)=4 minus the same grab bar of 1 = 3.
    expect(startBarOf(project, clipId)).toBe(before + 3);
  });
});

describe("audit16 · audio-clip fade drag commits instead of being swallowed", () => {
  const domRectW = (width: number) =>
    ({
      left: 0,
      top: 0,
      width,
      height: 40,
      right: width,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  const renderAudioArrangement = () => {
    const base = createDefaultProject();
    const doc = addAudioClip(base, base.tracks[0].id, "factory.loop", 0, 4).execute(base);
    const clipId = doc.arrangement.audioClips![0].id;
    const project = new ProjectStore(doc);
    const selectionStore = new SelectionStore();
    const services = { ...mockServices(doc), store: project } as unknown as Services;
    render(
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(
          SelectionContext.Provider,
          { value: selectionStore },
          createElement(ArrangementPanel) as ReactElement,
        ),
      ),
    );
    const lane = document.querySelector(".arr-lane");
    if (lane) vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(domRectW(2000));
    const handle = document.querySelector(".arr-audio-clip-handle-fade.left");
    expect(handle, "the fade-in handle must be rendered").not.toBeNull();
    vi.spyOn(handle!, "getBoundingClientRect").mockReturnValue(domRectW(120));
    return { project, clipId, handle: handle! };
  };

  const fadeInOf = (project: ProjectStore, clipId: string) =>
    project.doc.arrangement.audioClips?.find((c) => c.id === clipId)?.fadeIn ?? 0;

  it("commits the fade when move + release land in ONE frame", () => {
    // The worst variant of the state-read class. The fade branch is guarded by
    // `Math.abs(fadePrev.fadeIn - origFadeIn) > 0.005`: a `fadePrev` read from
    // an uncommitted render still holds the ORIGINAL 0, the guard compares 0
    // with 0, and the whole gesture commits NOTHING. The user drags a fade,
    // releases, and the clip does not change.
    const { project, clipId, handle } = renderAudioArrangement();

    fireEvent.pointerDown(handle, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(handle, { clientX: 140, clientY: 20, pointerId: 1 });
      fireEvent.pointerUp(handle, { pointerId: 1 });
    });

    expect(fadeInOf(project, clipId)).toBeGreaterThan(0.005);
  });

  it("commits the fade across a multi-move drag", () => {
    const { project, clipId, handle } = renderAudioArrangement();

    fireEvent.pointerDown(handle, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 80, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 140, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(fadeInOf(project, clipId)).toBeGreaterThan(0.005);
  });
});

describe("audit16 · dock height stays clamped to the live viewport", () => {
  it("re-clamps a persisted over-tall dock when the window shrinks", () => {
    // A dock persisted on a 2000px-tall display stays 560px after the window
    // drops to 600px, where the ceiling is 420. clampDockHeight is the only
    // guard and it only ran at load time.
    const short = 600 * 0.7;
    expect(clampDockHeight(560, short)).toBeLessThan(560);
  });

  it("clampDockHeight never returns a value outside its own bounds", () => {
    for (const maxInner of [100, 200, 400, 600, 800, 1200, 4000]) {
      const v = clampDockHeight(99999, maxInner);
      expect(v).toBeGreaterThanOrEqual(DOCK_MIN_HEIGHT);
      expect(v).toBeLessThanOrEqual(Math.max(DOCK_MIN_HEIGHT + 40, DOCK_MAX_HEIGHT));
    }
  });
});
