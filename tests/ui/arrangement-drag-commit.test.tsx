import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, Profiler, type ReactElement } from "react";
import { ArrangementPanel } from "../../src/ui/ArrangementPanel";
import { ProjectStore } from "../../src/store/ProjectStore";
import { SelectionStore } from "../../src/store/SelectionStore";
import { SelectionContext, ServicesContext } from "../../src/ui/context";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { addArrangementClip } from "../../src/commands/arrangement";
import { mockServices } from "../helpers";
import type { Services } from "../../src/services";
import type { ProjectDocument } from "../../src/project-model/types";

/**
 * ARRANGEMENT DRAG COMMIT GATE (audit 15, 2026-10-04)
 *
 * Audit 15 found ZERO render-cost coverage anywhere in the suite while
 * measuring the arrangement drag. This gate locks the one property of that
 * path which is both important and deterministically assertable.
 *
 *   A pointermove commits EXACTLY ONCE. Twice is the signature of reading a
 *   live gesture value out of React state instead of a ref — the defect class
 *   Audit 16 fixed in four places (Slider, DragNumber, scene-clip drag,
 *   audio-clip fade/gain/stretch/trim). Zero is the gesture being dropped.
 *
 * Why the per-move VECTOR, not a total: an aggregate cannot tell "one commit
 * per move" from "move 7 commits twice, move 8 commits zero". Both sum to
 * moves. The bug shapes are in the vector, so the vector is what is asserted.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO COST ASSERTION HERE — a deliberate omission, not an oversight
 * ---------------------------------------------------------------------------
 * The same audit measured commit COST and it is O(clips): the panel renders
 * every clip (2/1, 51/50, 201/200 rendered vs. in-document), so each of those
 * optimal commits reconciles the whole list. A total-cost ratio gate was built
 * and then FALSIFIED, twice:
 *
 *   - Injected an O(N²) scan in the clip render loop → total ratio 8.92×,
 *     against a 16× budget. Gate passed a pathology it was built for.
 *   - Replaced it with a far heavier proportional regression
 *     (JSON.stringify(clips) per clip) → 11.10×. Still passed.
 *   - MarginAL slope was tried as the statistic: 1.21 with the quadratic
 *     injected vs. 1.18 baseline — a 0.03 difference, i.e. noise.
 *
 * Baseline ratios without any injected regression ranged 5.5×–10.9× across
 * runs; with the heavy regression, 8.9×–11.1×. The bands overlap, so a jsdom
 * cost gate cannot separate the two. The reason is structural: React's DOM
 * reconciliation dominates the commit, and it is swamped by machine load on a
 * box running parallel agents.
 *
 * Shipping that gate would be the "test that cannot fail" trap — a rigorous-
 * looking assertion with no teeth. So the cost property is left as a DOCUMENTED
 * FINDING (docs/AUDIT-15-PERFORMANCE-STATIC-2026-10-04.md, P1) instead of a
 * fake guard. A real cost gate needs a real browser harness and a
 * load-calibrated baseline, not jsdom wall-clock.
 */

const domRect = (left: number, width: number) =>
  ({ left, top: 0, width, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

/** N scene clips packed after whatever the template already contains. */
function withClips(n: number): ProjectDocument {
  let doc = createProjectFromTemplate("house");
  const sceneId = doc.scenes[0].id;
  let bar = 0;
  for (const c of doc.arrangement.clips) bar = Math.max(bar, c.startBar + c.lengthBars);
  for (let i = 0; i < n; i++) {
    // addArrangementClip throws on overlap, hence the packed cursor above.
    doc = addArrangementClip(doc, sceneId, bar, 4).execute(doc);
    bar += 4;
  }
  return doc;
}

interface DragProbe {
  clips: number;
  renderedClips: number;
  /** Commits attributed to each individual pointermove, in order. */
  perMove: number[];
}

function drag(clips: number, moves: number): DragProbe {
  const doc = withClips(clips);
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;

  let commits = 0;
  render(
    createElement(
      Profiler,
      {
        id: `arr-${clips}`,
        // actualDuration is 0 for renders that bail out; a bailed-out render
        // is not a commit for this property, so it is not counted.
        onRender: (_id: string, _phase: string, actual: number) => {
          if (actual > 0) commits++;
        },
      },
      createElement(
        ServicesContext.Provider,
        { value: services },
        createElement(
          SelectionContext.Provider,
          { value: new SelectionStore() },
          createElement(ArrangementPanel) as ReactElement,
        ),
      ),
    ),
  );
  const lane = document.querySelector(".arr-lane");
  const clipEl = document.querySelector(".arr-clip");
  // The drag must have something to act on, or the gate below is measuring a
  // panel that never rendered — the positive control for the whole file.
  expect(lane, "arrangement lane not rendered — the probe measured nothing").not.toBeNull();
  expect(clipEl, "no clip rendered — the probe measured nothing").not.toBeNull();
  vi.spyOn(lane!, "getBoundingClientRect").mockReturnValue(domRect(0, 4_000_000));
  vi.spyOn(clipEl!, "getBoundingClientRect").mockReturnValue(domRect(0, 100));

  const perMove: number[] = [];
  fireEvent.pointerDown(clipEl!, { button: 0, clientX: 40, pointerId: 1 });
  for (let i = 1; i <= moves; i++) {
    const before = commits;
    act(() => {
      fireEvent.pointerMove(clipEl!, { clientX: 40 + i * 10, pointerId: 1 });
    });
    perMove.push(commits - before);
  }
  fireEvent.pointerUp(clipEl!, { pointerId: 1 });
  const renderedClips = document.querySelectorAll(".arr-clip").length;
  cleanup();
  return { clips, renderedClips, perMove };
}

afterEach(() => cleanup());

describe("arrangement drag commit gate", () => {
  it("commits exactly once per pointermove at every clip count", () => {
    const results = [1, 25, 100].map((clips) => drag(clips, 20));
    for (const r of results) {
      console.info(
        `[arr-commit] ${r.clips} clips (${r.renderedClips} rendered): ` +
          `${r.perMove.length} moves, per-move commits = ${[...new Set(r.perMove)].join(",")}`,
      );
    }
    for (const r of results) {
      expect(
        r.perMove,
        `${r.clips} clips: every pointermove must commit exactly once, saw [${[...new Set(r.perMove)].join(",")}]`,
      ).toEqual(new Array(r.perMove.length).fill(1));
    }
  });

  it("actually renders the clip set it is gating on", () => {
    // Anchors the gate to a non-trivial document. Without this, a future change
    // that stopped rendering clips would make the commit gate green for the
    // wrong reason.
    const r = drag(100, 4);
    expect(r.renderedClips, "expected a populated arrangement").toBeGreaterThanOrEqual(100);
  });
});
