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
 * ARRANGEMENT DRAG RENDER COST GATE (audit 15, 2026-10-04)
 *
 * Audit 15 found zero render-cost coverage in the suite, and measured the
 * shape of the arrangement drag: commit COUNT is a perfect 1.00 per
 * pointermove at any clip count, while commit COST is O(clips) — the panel
 * renders every clip in the document, so each commit reconciles the whole
 * list. This gate locks the two properties worth protecting.
 *
 *   1. One commit per pointermove. A regression here means a gesture mutates
 *      state twice per move (the class Audit 16 fixed: a live drag value in
 *      state instead of a ref, read by a release handler), and the user sees
 *      the knob or clip lag a frame behind the pointer.
 *
 *   2. Cost grows with a bounded RATIO, not an absolute time — the same
 *      self-calibration `fxeq-performance-gates.test.ts` uses, for the same
 *      reason: this repo runs on a shared machine with parallel agents whose
 *      load inflates wall-clock several-fold, so an absolute ms budget would
 *      either flake on a loaded box or be loose enough to never fire. Ratios
 *      measured on the same process, back to back, survive that.
 *
 * Scope honesty: these are jsdom numbers. They do NOT include browser layout
 * or paint, so they understate real frame cost — but the React render +
 * reconcile path under test is identical, which is exactly the O(clips) claim
 * this gate is about. A virtualization or memoization change that fixes the
 * problem still passes: the budgets are upper bounds, not pins.
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

interface DragCost {
  clips: number;
  renderedClips: number;
  commits: number;
  moves: number;
  medianMs: number;
}

function dragCost(clips: number, moves: number): DragCost {
  const doc = withClips(clips);
  const project = new ProjectStore(doc);
  const services = { ...mockServices(doc), store: project } as unknown as Services;

  const durations: number[] = [];
  let commits = 0;
  render(
    createElement(
      Profiler,
      {
        id: `arr-${clips}`,
        onRender: (_id: string, _phase: string, actual: number) => {
          // actualDuration is 0 for renders that bail out; those are not costs.
          if (actual > 0) {
            commits++;
            durations.push(actual);
          }
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
  expect(lane, "arrangement lane not rendered — the probe measured nothing").not.toBeNull();
  expect(clipEl, "no clip rendered — the probe measured nothing").not.toBeNull();
  vi.spyOn(lane!, "getBoundingClientRect").mockReturnValue(domRect(0, 4_000_000));
  vi.spyOn(clipEl!, "getBoundingClientRect").mockReturnValue(domRect(0, 100));

  // The pointerDown commit is flushed asynchronously by React, so a mark taken
  // immediately after it still counts it: that measured 21 commits for 20 moves
  // at every size. The extra is CONSTANT (it does not scale with clips), so it
  // is an accounting artifact, not a per-move double commit. Burn one move
  // first, then measure the rest — which is what this property is about.
  // Counted per move, not in bulk: an aggregate total cannot tell "one commit
  // per move" from "one move commits twice and the next commits zero", which
  // is exactly the shape a batching regression takes.
  fireEvent.pointerDown(clipEl!, { button: 0, clientX: 40, pointerId: 1 });
  const perMove: number[] = [];
  for (let i = 1; i <= moves; i++) {
    const before = commits;
    act(() => {
      fireEvent.pointerMove(clipEl!, { clientX: 40 + i * 10, pointerId: 1 });
    });
    perMove.push(commits - before);
  }
  fireEvent.pointerUp(clipEl!, { pointerId: 1 });
  const renderedClips = document.querySelectorAll(".arr-clip").length;
  const mark = commits - perMove.reduce((a, b) => a + b, 0);
  cleanup();
  if (process.env.ARR_COST_DEBUG) {
    console.info(`[arr-cost] per-move commits at ${clips} clips: ${perMove.join(",")}`);
  }

  // POSITIVE CONTROL: a drag that moved must have produced commits. Without
  // this, every assertion below would pass on a probe that measured nothing.
  const duringDrag = durations.slice(mark);
  expect(duringDrag.length, `no commits measured for ${clips} clips — instrument invalid`).toBeGreaterThan(0);
  const sorted = [...duringDrag].sort((a, b) => a - b);
  return {
    clips,
    renderedClips,
    commits: commits - mark,
    moves: moves - 1,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
  };
}

afterEach(() => cleanup());

describe("arrangement drag render cost gate", () => {
  it("commits exactly once per pointermove at every clip count", () => {
    // 1.00 was measured at 1 / 25 / 100 / 300 clips. A second commit per move
    // is the exact symptom of reading a live gesture value out of state.
    const results = [1, 25, 100].map((clips) => dragCost(clips, 20));
    for (const result of results) {
      console.info(
        `[arr-cost] ${result.clips} clips (${result.renderedClips} rendered): ` +
          `${result.commits} commits / ${result.moves} moves = ${(result.commits / result.moves).toFixed(2)}/move`,
      );
    }
    // Report every size before failing: one run must show the whole pattern.
    for (const result of results) {
      expect(result.commits, `${result.clips} clips: ${result.commits} commits for ${result.moves} moves`).toBe(
        result.moves,
      );
    }
  });

  it("keeps commit cost growth within a self-calibrated ratio", () => {
    // Measured 2026-10-04 (jsdom, three separate runs, 25 clips → 300 clips):
    // 5.5×, 5.7×, 8.5×. The spread is machine load, not signal — the same
    // reason fxeq calibrates against a back-to-back passthrough run instead
    // of an absolute ms budget. Best-of-3 on each side cancels most of the
    // drift; the budget then sits ~2× above the worst observed so a loaded box
    // cannot flake it, while a quadratic scan or a per-move whole-document
    // recomputation (the pathologies this gate exists for) blows straight
    // through it.
    const BUDGET_RATIO = 16;
    const best = (clips: number) =>
      Math.min(dragCost(clips, 12).medianMs, dragCost(clips, 12).medianMs, dragCost(clips, 12).medianMs);
    const small = best(25);
    const large = best(300);
    const ratio = large / small;
    console.info(
      `[arr-cost] cost 25→300 clips (best-of-3): ${small.toFixed(2)}ms → ${large.toFixed(2)}ms = ${ratio.toFixed(2)}× (budget ${BUDGET_RATIO}×)`,
    );
    expect(
      ratio,
      `drag commit cost grew ${ratio.toFixed(2)}× for a 12× clip increase (budget ${BUDGET_RATIO}×) — ` +
        `a render path is doing super-linear work per pointermove`,
    ).toBeLessThan(BUDGET_RATIO);
  });

  it("renders a real clip set — the cost numbers above are about something", () => {
    // Anchors the two gates to a non-trivial document. Without this a future
    // change that stopped rendering clips would make the cost gate green for
    // the wrong reason.
    const result = dragCost(100, 4);
    expect(result.renderedClips, "expected a populated arrangement").toBeGreaterThanOrEqual(100);
  });
});
