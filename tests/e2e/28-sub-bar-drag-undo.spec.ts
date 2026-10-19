import { expect, test } from "playwright/test";

import { clipGeometry, dismissTransientToasts, openArrangement } from "./_studio";

/**
 * DAW Audit 01 — Editing & Timeline: pointer gestures on arrangement clips.
 *
 * SCOPE, STATED HONESTLY
 *
 * An earlier revision of this spec claimed to be the browser-level regression
 * test for the "dead undo step" fix (ABSENT ≡ `undefined` in the delta engine).
 * It is NOT, and a negative control proved it: with the delta fix reverted,
 * this spec still passed. It is kept because it guards a real, separate
 * property — that a real pointer drag on an arrangement clip actually moves it
 * and is undoable — and because the measurement below corrected a wrong claim
 * made in the original audit.
 *
 * WHAT WAS WRONG IN THE ORIGINAL AUDIT
 *
 * The audit reported the dead-undo defect as reachable by dragging a scene clip
 * less than half a bar, on the theory that the panel compares an UNROUNDED drag
 * value while `moveArrangementClip` rounds. Measured in Chromium, that is false:
 *
 *   - `barFromEventAt` (ArrangementPanel.tsx:2433) already uses `Math.floor`,
 *     so scene-clip drags are bar-GRANULAR. A 3 px drag moved a clip by exactly
 *     one whole bar (left 120 → 150), not by zero.
 *   - because the panel's own bar value is already an integer, the guard
 *     `finalDrag.startBar !== current.origStart` compares two integers and is
 *     effective; `moveArrangementClip`'s `Math.round` is a no-op for UI callers.
 *   - MCP pre-rounds too (`Math.round(Number(record.toBar))`, tools.ts:5145).
 *
 * So the UI was never the exposure. The defect is reachable at the COMMAND
 * layer — `moveArrangementClip(doc, id, currentBar)` — which is what MCP,
 * the intent engine and scripts call, and what
 * `tests/no-op-edit-dead-undo.test.ts` covers with a verified negative control.
 *
 * What this spec therefore asserts:
 *   1. a drag that stays inside one floored bar cell changes nothing AND does
 *      not consume an undo step — a UI-level guard that held before and after
 *      the fix (measured both ways, see above);
 *   2. a real drag still moves the clip and Undo still restores it — this one
 *      genuinely fails if pointer handling regresses.
 *
 * Measured from committed DOM state, never mid-drag.
 */

test("a same-bar drag changes nothing and consumes no undo step", async ({ page }) => {
  const jsErrors: string[] = [];
  page.on("pageerror", (e) => jsErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The headless audio device error is environmental, not an editing defect:
    // the spec never starts playback and no existing spec filters it either.
    if (
      m.type() === "error" &&
      !/net::ERR_CONNECTION_REFUSED|Failed to load resource|AudioContext encountered an error/.test(m.text())
    ) {
      jsErrors.push(m.text());
    }
  });

  await openArrangement(page);

  // ── Fixture: a REAL edit, so the undo stack has something honest in it ────
  const arrangeToolbar = page.getByLabel("ARR", { exact: true });
  await page.locator(".arr-clip").first().click();
  await arrangeToolbar.getByRole("button", { name: "DUP", exact: true }).click();
  await page.waitForTimeout(500);

  const afterDup = await clipGeometry(page);
  expect(afterDup.length, "fixture must contain the duplicated clip").toBeGreaterThanOrEqual(2);
  console.info(`[samebar] afterDup=${JSON.stringify(afterDup)}`);

  // Bar width is derived from the committed DOM, never assumed: a 4-bar clip
  // renders `4 * barWidth - 4` px (the 4 px is the inset the ripple spec
  // already documents), and the duplicate lands exactly one clip-width later.
  const barWidth = (afterDup[0].width + 4) / 4;
  console.info(`[samebar] barWidth=${barWidth}`);

  const target = page.locator(".arr-clip").last();
  // The lane sits below the fold at the default 1280x720 viewport and
  // `boundingBox()` happily returns coordinates OUTSIDE it. A mouse event at
  // y > 720 lands on nothing and the gesture silently does nothing — which
  // makes "the clip did not move" pass for entirely the wrong reason. An
  // earlier revision of this spec passed vacuously because of exactly that.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("the arrangement clip has no visible bounds to drag");
  const view = page.viewportSize();
  expect(box.y, "the drag point must be inside the viewport").toBeLessThan(view!.height);

  // Grab 40 % into the clip's first bar cell and release a few px later, so
  // both floor to the SAME bar index. 40 % is far enough from the clip's own
  // edge to avoid the 10 px trim/resize zones.
  const grabX = box.x + boxWidthOffset(box.width, barWidth);
  const dragY = box.y + box.height / 2;
  const dragPx = Math.max(2, Math.floor(barWidth * 0.15));
  console.info(`[samebar] grabX=${grabX} dragPx=${dragPx}`);

  await page.mouse.move(grabX, dragY);
  await page.mouse.down();
  await page.mouse.move(grabX + dragPx, dragY, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await dismissTransientToasts(page);

  // ── Clause 1: the clip did not actually move ─────────────────────────────
  const afterDrag = await clipGeometry(page);
  for (const [i, clip] of afterDrag.entries()) {
    expect(
      Math.abs(clip.left - afterDup[i].left),
      `a ${dragPx}px drag inside one bar cell must not move clip ${i}`,
    ).toBeLessThan(0.51);
  }

  // ── Clause 2: the no-op drag pushed NO undo step ─────────────────────────
  // One Undo must now consume the FIXTURE's duplicate, not the drag.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(600);

  const afterUndo = await clipGeometry(page);
  console.info(`[samebar] afterUndo=${JSON.stringify(afterUndo)}`);

  expect(
    afterUndo.length,
    "Undo after a same-bar drag must undo the PREVIOUS real edit (the duplicate), not the drag — " +
      "an unchanged clip count means the drag consumed an undo step for nothing",
  ).toBe(afterDup.length - 1);

  console.info(`[samebar] jsErrors=${jsErrors.length}`);
  expect(jsErrors, jsErrors.join(" | ")).toHaveLength(0);
});

/** 40 % of a bar's width past the clip's left edge, clamped inside the clip. */
function boxWidthOffset(clipWidth: number, barWidth: number): number {
  const target = barWidth * 0.4;
  return Math.min(target, Math.max(4, clipWidth / 2 - 2));
}

test("a full-bar drag still records a real undo step", async ({ page }) => {
  const jsErrors: string[] = [];
  page.on("pageerror", (e) => jsErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !/net::ERR_CONNECTION_REFUSED|Failed to load resource|AudioContext encountered an error/.test(m.text())
    ) {
      jsErrors.push(m.text());
    }
  });

  await openArrangement(page);

  const target = page.locator(".arr-clip").first();
  const before = await clipGeometry(page);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("the arrangement clip has no visible bounds to drag");
  const view = page.viewportSize();
  expect(box.y, "the drag point must be inside the viewport").toBeLessThan(view!.height);

  // A whole clip width is unambiguously more than one bar at any zoom.
  const dx = Math.max(40, box.width / 2);
  const startX = box.x + box.width / 2;
  const dragY = box.y + box.height / 2;

  await page.mouse.move(startX, dragY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, dragY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await dismissTransientToasts(page);

  const afterDrag = await clipGeometry(page);
  const movedPx = afterDrag[0].left - before[0].left;
  console.info(`[samebar] realDrag movedPx=${movedPx} (dx=${dx})`);
  expect(Math.abs(movedPx), "a full-bar drag must actually move the clip").toBeGreaterThan(1);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(500);
  const afterUndo = await clipGeometry(page);
  expect(
    Math.abs(afterUndo[0].left - before[0].left),
    "Undo must restore the clip to where a real drag started",
  ).toBeLessThan(0.51);

  console.info(`[samebar] jsErrors=${jsErrors.length}`);
  expect(jsErrors, jsErrors.join(" | ")).toHaveLength(0);
});
