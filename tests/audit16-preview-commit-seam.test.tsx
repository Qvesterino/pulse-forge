/**
 * AUDIT 16 (contract, restated) — TWIST curve drag auditions on move and
 * commits the document ONCE on release.
 *
 * `pointerToParams` used to call the host's `onParam` per pointermove, which
 * is a full document mutation (normalize -> undo push -> engine re-projection)
 * each event: a 60-move gesture cost ~120 writes.
 *
 * The contract these specs pin, matching Kaskada / Ultina / FxEq / MorphDynamics:
 *
 *   1. pointermove auditions through the RUNTIME and writes NO document
 *   2. pointerup writes the document ONCE, carrying the final value
 *   3. pointercancel writes nothing and restores the document value
 *
 * These are NEGATIVE assertions by construction: the interesting behaviour is
 * what must NOT happen during the drag.
 *
 * Audit's own clamp guard for the same gesture lives in
 * tests/audit17-param-range-contract.test.tsx (a drag must never hand the
 * boundary a focusHz outside the ParamDef range).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { SkrutkaPanel } from "../src/ui/SkrutkaPanel";
import { ServicesContext } from "../src/ui/context";
import { mockServices } from "./helpers";
import type { Services } from "../src/services";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import type { ProjectDocument } from "../src/project-model/types";

function testDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  return createProjectFromTemplate("house");
}

/** Records RUNTIME auditions separately from document writes — which of the
 * two a pointermove is allowed to touch is the entire point of these specs. */
function makeServices(doc: ProjectDocument) {
  const previewed: Array<[string, string, string, number]> = [];
  const base = mockServices(doc);
  const services = {
    ...base,
    engine: {
      ...base.engine,
      previewFxParam: (trackId: string, fxId: string, paramId: string, value: number) => {
        previewed.push([trackId, fxId, paramId, value]);
      },
      getLiveAudioContext: () => null,
    },
  } as unknown as Services;
  return { services, previewed };
}

function mount(params: Record<string, number>, onParam: (id: string, v: number) => void, services: Services) {
  render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(SkrutkaPanel, {
        trackId: "track-1",
        fxId: "fx-1",
        params,
        degraded: false,
        onParam,
      }) as ReactElement,
    ),
  );
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 200,
    right: 400,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return canvas;
}

const at = (clientX: number) => ({ clientX, clientY: 100, pointerId: 1, bubbles: true }) as never;

describe("AUDIT 16/17: TWIST curve drag writes the document once", () => {
  beforeEach(() => cleanup());

  it("auditions every move but commits exactly one pair, on release", () => {
    const { services, previewed } = makeServices(testDoc());
    const onParam = vi.fn();
    const onGestureStart = vi.fn();
    const onGestureEnd = vi.fn();

    render(
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(SkrutkaPanel, {
          trackId: "track-1",
          fxId: "fx-1",
          params: { focusHz: 220, dispersion: 0.35 },
          degraded: false,
          onParam,
          onGestureStart,
          onGestureEnd,
        }) as ReactElement,
      ),
    );
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      right: 400,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    act(() => {
      fireEvent.pointerDown(canvas, at(80));
    });
    for (const x of [90, 110, 140, 170, 200]) {
      act(() => {
        fireEvent.pointerMove(canvas, at(x));
      });
    }

    // THE NEGATIVE ASSERTION: six pointer samples, zero document writes.
    expect(onParam).not.toHaveBeenCalled();
    // Two params per sample (focusHz + dispersion), runtime only.
    expect(previewed.length).toBeGreaterThanOrEqual(12);

    act(() => {
      fireEvent.pointerUp(canvas, at(200));
    });

    // ONE undoable pair, carrying the LAST auditioned value.
    expect(onParam).toHaveBeenCalledTimes(2);
    expect(onParam.mock.calls.map((c) => c[0])).toEqual(["focusHz", "dispersion"]);
    const lastById = new Map(previewed.map(([, , id, value]) => [id, value]));
    expect(onParam.mock.calls[0][1]).toBe(lastById.get("focusHz"));
    expect(onParam.mock.calls[1][1]).toBe(lastById.get("dispersion"));
    expect(onGestureStart).toHaveBeenCalledTimes(1);
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
  });

  it("a cancelled drag writes NOTHING and restores the document curve", () => {
    const { services, previewed } = makeServices(testDoc());
    const onParam = vi.fn();
    const canvas = mount({ focusHz: 220, dispersion: 0.35 }, onParam, services);

    act(() => {
      fireEvent.pointerDown(canvas, at(320));
      fireEvent.pointerMove(canvas, at(60));
    });
    const auditioned = previewed.length;
    act(() => {
      fireEvent.pointerCancel(canvas);
    });

    expect(onParam).not.toHaveBeenCalled();
    // The cancel pushed the DOCUMENT params back into the runtime, so the
    // worklet stops sounding a curve the project never took.
    expect(previewed.length).toBeGreaterThan(auditioned);
    const lastById = new Map(previewed.map(([, , id, value]) => [id, value]));
    expect(lastById.get("focusHz")).toBe(220);
    expect(lastById.get("dispersion")).toBe(0.35);
  });
});
