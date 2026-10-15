import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EqCurveCanvas } from "../src/ui/EqCurveCanvas";

/**
 * The GESTURE contract of the EQ curve, as a component test.
 *
 * WHY THIS FILE EXISTS ALONGSIDE tests/effects-eq-curve-drag.test.ts
 * ------------------------------------------------------------------
 * That file has 16 tests and all of them exercise PURE FUNCTIONS out of
 * `src/effects/eqCurve.ts` — hitEqBand, eqPointToDb, eqXToHz, eqBands. It was
 * 16/16 green while the curve silently wrote to the document on a click the
 * user never dragged: `onPointerDown` raised the "the user moved" flag from the
 * pointer's POSITION relative to the band rather than from pointer movement,
 * so a press-and-release committed whatever dB the pointer happened to sit at
 * (-1.09 dB, measured in the browser). No pure-function test can see that,
 * because the defect was never in a pure function — it was in the component's
 * event handling. The browser gate caught it; nothing else did.
 *
 * So this file drives the real component with real pointer events. It is the
 * regression lock for the class of bug the maths suite structurally cannot see.
 */

/** jsdom gives every element a 0x0 box, so stub the one the canvas reads. */
function stubBox(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;
  // jsdom ships no 2d context and logs a "Not implemented" warning per draw.
  // The component already treats a null context as "nothing to paint", and the
  // drawing is not what these tests are about, so silence it here rather than
  // letting ~40 warnings bury a real failure.
  (el as HTMLCanvasElement).getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
}

const W = 300;
const H = 44;

/** Pointer position for a frequency on the 20 Hz – 20 kHz log axis. */
function xForHz(hz: number): number {
  return (Math.log(hz / 20) / Math.log(20000 / 20)) * W;
}
/** Pointer position for a dB value: 0 dB is the vertical centre. */
function yForDb(db: number): number {
  return H / 2 - (db / 24) * (H / 2);
}

function setup(overrides: Record<string, number> = {}) {
  const onCommit = vi.fn();
  const params = { lowShelfGain: 0, lowMidGain: 0, highMidGain: 0, highShelfGain: 0, ...overrides };
  const { container } = render(<EqCurveCanvas params={params} onCommit={onCommit} width={W} height={H} />);
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  stubBox(canvas, W, H);
  // setPointerCapture/releasePointerCapture are DOM APIs jsdom does not model.
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  canvas.hasPointerCapture = () => true;
  return { canvas, onCommit, params };
}

const down = (c: HTMLElement, x: number, y: number, id = 1) =>
  fireEvent.pointerDown(c, { clientX: x, clientY: y, pointerId: id, bubbles: true });
const move = (c: HTMLElement, x: number, y: number, id = 1) =>
  fireEvent.pointerMove(c, { clientX: x, clientY: y, pointerId: id, bubbles: true });
const up = (c: HTMLElement, x: number, y: number, id = 1) =>
  fireEvent.pointerUp(c, { clientX: x, clientY: y, pointerId: id, bubbles: true });

afterEach(() => cleanup());

describe("EqCurveCanvas gesture", () => {
  it("commits the dragged band on release", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(0));
    move(canvas, x, yForDb(9));
    up(canvas, x, yForDb(9));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe("highMidGain");
    expect(onCommit.mock.calls[0][1]).toBeCloseTo(9, 1);
  });

  it("writes nothing while the pointer is still down", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(0));
    move(canvas, x, yForDb(6));
    move(canvas, x, yForDb(11));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits ONCE per gesture, not once per move", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(0));
    for (let db = 1; db <= 10; db++) move(canvas, x, yForDb(db));
    up(canvas, x, yForDb(10));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  // THE REGRESSION. Pressing a band and releasing without moving is a CLICK.
  // It must not write: it would push an undo step for a value the user never
  // chose, and the band would jump to wherever the pointer happened to land.
  it("a press and release with no movement writes nothing", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    // Deliberately NOT on the band's exact row: the pointer sits a few dB off,
    // which is exactly the case the old code mistook for movement.
    down(canvas, x, yForDb(-1.09));
    up(canvas, x, yForDb(-1.09));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a press and release off the band row still writes nothing", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(4));
    up(canvas, x, yForDb(4));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a press that misses every band starts no gesture at all", () => {
    const { canvas, onCommit } = setup();
    down(canvas, xForHz(900), yForDb(20));
    move(canvas, xForHz(900), yForDb(4));
    up(canvas, xForHz(900), yForDb(4));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores movement from a different pointer than the one that pressed", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(0), 1);
    move(canvas, x, yForDb(12), 2);
    up(canvas, x, yForDb(12), 2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a cancelled gesture does not commit", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(0));
    move(canvas, x, yForDb(8));
    fireEvent.pointerCancel(canvas, { clientX: x, clientY: yForDb(8), pointerId: 1, bubbles: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("each band writes its own param, so a point and its knob are one control", () => {
    for (const [hz, paramId] of [
      [120, "lowShelfGain"],
      [400, "lowMidGain"],
      [2500, "highMidGain"],
      [6000, "highShelfGain"],
    ] as const) {
      const { canvas, onCommit } = setup();
      const x = xForHz(hz);
      down(canvas, x, yForDb(0));
      move(canvas, x, yForDb(7));
      up(canvas, x, yForDb(7));
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0][0]).toBe(paramId);
    }
  });

  it("dragging tracks the pointer's current row, not a fixed offset from the grab", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(0));
    move(canvas, x, yForDb(5));
    move(canvas, x, yForDb(-3));
    up(canvas, x, yForDb(-3));
    expect(onCommit.mock.calls[0][1]).toBeCloseTo(-3, 1);
  });

  it("marks itself dragging only while a band is held", () => {
    const { canvas } = setup();
    const x = xForHz(2500);
    expect(canvas.className).not.toContain("is-dragging");
    down(canvas, x, yForDb(0));
    expect(document.querySelector("canvas")?.className).toContain("is-dragging");
    up(canvas, x, yForDb(3));
    expect(document.querySelector("canvas")?.className).not.toContain("is-dragging");
  });

  it("clamps a drag past the canvas to the drawn range instead of overshooting", () => {
    const { canvas, onCommit } = setup();
    const x = xForHz(2500);
    down(canvas, x, yForDb(0));
    move(canvas, x, -500);
    up(canvas, x, -500);
    expect(onCommit.mock.calls[0][1]).toBeLessThanOrEqual(24);
  });
});
