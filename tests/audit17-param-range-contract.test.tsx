/**
 * AUDIT 17 — a gesture must not hand the boundary a value the document rejects.
 *
 * `skrutkaParams.focusHz` declares min 40 / max 4000 (log taper). The canvas
 * drag mapped pointer x onto 30…16000 Hz instead, so past roughly 78 % of the
 * canvas width it produced values the parameter contract does not allow.
 *
 * What that looks like depends on which branch you are on, and both are
 * defects:
 *
 *   - with the audit-16 preview/commit path (`main`): previewFxParam writes
 *     the runtime RAW while setEffectParam CLAMPS on commit. The worklet
 *     auditions 8 kHz, the drawing does not move (it reads the document), and
 *     releasing snaps the sound back. Preview and commit disagree.
 *   - without it (`feat/channel-row-merge`): every move writes the document
 *     directly and the clamp silently swallows the value, so the right-hand
 *     fifth of the canvas is a region where nothing moves and nothing says so.
 *
 * So the spec is deliberately branch-agnostic: it asserts the property of the
 * BOUNDARY, not of one implementation — every focusHz value observed crossing
 * it, on EITHER channel, must lie inside the declared range.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { SkrutkaPanel } from "../src/ui/SkrutkaPanel";
import { ServicesContext } from "../src/ui/context";
import { mockServices } from "./helpers";
import type { Services } from "../src/services";
import { skrutkaParams } from "../src/effects/definitions";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import type { ProjectDocument } from "../src/project-model/types";

function testDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  return createProjectFromTemplate("house");
}

/** The authoritative range the document will actually store. */
const FOCUS_MIN = skrutkaParams.find((p) => p.id === "focusHz")?.min ?? 40;
const FOCUS_MAX = skrutkaParams.find((p) => p.id === "focusHz")?.max ?? 4000;

interface Harness {
  services: Services;
  /** focusHz values that crossed the boundary, by channel. */
  auditioned: number[];
  written: number[];
  canvas: HTMLCanvasElement;
  onParam: ReturnType<typeof vi.fn>;
}

function mount(params: Record<string, number> = { focusHz: 220, dispersion: 0.35 }): Harness {
  const auditioned: number[] = [];
  const written: number[] = [];
  const onParam = vi.fn((paramId: string, value: number) => {
    if (paramId === "focusHz") written.push(value);
  });

  const base = mockServices(testDoc());
  const services = {
    ...base,
    engine: {
      ...base.engine,
      previewFxParam: (_trackId: string, _fxId: string, paramId: string, value: number) => {
        if (paramId === "focusHz") auditioned.push(value);
      },
      getLiveAudioContext: () => null,
    },
  } as unknown as Services;

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

  return { services, auditioned, written, canvas, onParam };
}

describe("AUDIT 17: SKRUTKA drag stays inside the parameter's reachable range", () => {
  beforeEach(() => cleanup());

  it("hands the boundary no focusHz outside the declared range, on any channel", () => {
    const h = mount();

    act(() => {
      fireEvent.pointerDown(h.canvas, { clientX: 20, clientY: 100, pointerId: 1, bubbles: true } as never);
    });
    // Walk the full width into the region the old code mapped to 8 kHz and up.
    for (const frac of [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0]) {
      act(() => {
        fireEvent.pointerMove(h.canvas, { clientX: 400 * frac, clientY: 100, pointerId: 1, bubbles: true } as never);
      });
    }
    act(() => {
      fireEvent.pointerUp(h.canvas, { clientX: 400, clientY: 100, pointerId: 1, bubbles: true } as never);
    });

    // LIVENESS: a panel that did nothing would pass the range assertion
    // vacuously, so prove the drag actually crossed the boundary at all.
    expect(h.auditioned.length + h.written.length).toBeGreaterThan(0);

    const all = [...h.auditioned, ...h.written];
    for (const value of all) {
      expect(value).toBeLessThanOrEqual(FOCUS_MAX);
      expect(value).toBeGreaterThanOrEqual(FOCUS_MIN);
    }
  });

  it("the reachable range comes from the ParamDef, not a second literal", () => {
    // Guards the duplication that caused this. If someone re-inlines 30…16000
    // as the drag range, the assertion above is what notices — this row just
    // pins the two numbers so the contract cannot silently widen.
    expect(FOCUS_MAX).toBeLessThan(16000);
    expect(FOCUS_MIN).toBeGreaterThan(30);
  });
});
