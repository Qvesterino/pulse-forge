import { expect, test } from "playwright/test";

import { clipGeometry, openArrangement } from "./_studio";

/**
 * §16 RIPPLE SEMANTICS — the highest-blast-radius editing mode in the panel,
 * verified in a real browser because its whole contract is about what happens
 * to the clips you did NOT touch.
 *
 * The contract is stated in the commands themselves
 * (`src/commands/clipPlayback.ts`):
 *   - `deleteArrangementClipRipple` — "removing a clip closes the gap: every
 *     later clip slides left by the deleted length"
 *   - `resizeArrangementClipRipple` — "growing a clip pushes every later clip
 *     right ... the gaps after the edit stay exactly as before"
 *
 * That second clause is the one worth measuring: ripple is not "move
 * everything to the left", it is "the TAIL flows and the SPACES between tail
 * clips are preserved". A shift-everything implementation would satisfy the
 * first clause and silently destroy the arrangement's spacing, which is why
 * this spec compares GAPS rather than just positions.
 *
 * Everything is measured from committed DOM state (`style.left`,
 * `style.width`), never from a preview or a drag mid-flight.
 */

/** Committed geometry of every arrangement clip, in DOM order. */
const geometry = clipGeometry;

test("ripple delete closes the gap and preserves the spacing inside the tail", async ({ page }) => {
  const jsErrors: string[] = [];
  page.on("pageerror", (e) => jsErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/net::ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) {
      jsErrors.push(m.text());
    }
  });

  await openArrangement(page);

  // ── Fixture: three clips, side by side, with KNOWN gaps ─────────────────
  // Duplicating the template's single clip is the only way to build a tail in
  // this editor without a dialog, and the copy lands next to its original.
  const arrangeToolbar = page.getByLabel("ARR", { exact: true });
  await page.locator(".arr-clip").first().click();
  for (let i = 0; i < 2; i++) {
    await arrangeToolbar.getByRole("button", { name: "DUP", exact: true }).click();
    await page.waitForTimeout(350);
  }
  const before = await geometry(page);
  console.info(`[ripple] before=${JSON.stringify(before)}`);
  expect(before.length, "fixture must have a clip to ripple past").toBeGreaterThanOrEqual(2);

  // ── Turn ripple ON and confirm the control actually engaged ─────────────
  const ripple = arrangeToolbar.getByRole("button", { name: "RIPPLE OFF", exact: true });
  await ripple.click();
  await page.waitForTimeout(250);
  const engaged = page.locator("button.arr-ripple-toggle.on");
  expect(await engaged.count(), "the ripple toggle did not engage").toBeGreaterThan(0);
  console.info(`[ripple] toggleLabel=${await engaged.first().textContent()}`);

  // ── The gesture under test: remove the FIRST clip with ripple on ────────
  const removed = before[0];
  await page.locator(".arr-clip").first().click();
  await page.waitForTimeout(150);
  await arrangeToolbar.locator("button.btn-danger", { hasText: "DEL" }).click();
  await page.waitForTimeout(500);
  const after = await geometry(page);
  console.info(`[ripple] after=${JSON.stringify(after)}`);

  expect(after.length, "ripple delete must remove exactly one clip").toBe(before.length - 1);

  // §16 contract clause 1: the tail slid left — by ONE amount, the length of
  // the removed clip. Two things are asserted separately on purpose:
  //
  //  (a) "closes the gap" — the clip that followed now STARTS where the
  //      removed one started. For contiguous material that is the definition,
  //      and unlike a pixel subtraction it does not need to know how wide a
  //      clip renders: the committed `style.width` carries a ~4 px inset, so
  //      shifting by it instead of by the clip's bar length is off by exactly
  //      that inset. An earlier revision of this spec asserted
  //      `before[i+1].left - removed.width` and failed by 4 px against a
  //      CORRECT ripple — the assertion was wrong, not the editor.
  expect(after[0].left, "ripple must close the gap, not just remove the clip").toBe(removed.left);

  //  (b) uniform flow — every tail clip moved by the SAME amount. A
  //      "shift everything, including material before the edit" or a
  //      re-flowing implementation breaks this even when (a) still holds.
  const shifts = after.map((clip, i) => before[i + 1].left - clip.left);
  for (const [i, s] of shifts.entries()) {
    expect(Math.abs(s - shifts[0]), `clip ${i} shifted ${s} but clip 0 shifted ${shifts[0]}`).toBeLessThan(0.51);
  }
  expect(shifts[0], "the tail must actually move, not stand still").toBeGreaterThan(0);
  console.info(`[ripple] shift=${shifts[0]}px removedWidthRendered=${removed.width}px`);

  // §16 contract clause 2: the tail's INTERNAL spacing survived — the offsets
  // between surviving clips are exactly what they were. This is the assertion
  // that a shift-everything implementation fails while still passing (a).
  for (let i = 0; i + 1 < after.length; i++) {
    const offsetBefore = before[i + 2].left - before[i + 1].left;
    const offsetAfter = after[i + 1].left - after[i].left;
    expect(
      Math.abs(offsetAfter - offsetBefore),
      `spacing ${i} changed: ${offsetBefore} → ${offsetAfter} (ripple must preserve spacing, not re-flow it)`,
    ).toBeLessThan(0.51);
  }

  // ── Undo restores the whole ripple atomically (§22, §23) ─────────────────
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForTimeout(500);
  const restored = await geometry(page);
  expect(restored.length, "undo must restore the removed clip").toBe(before.length);
  for (const [i, clip] of restored.entries()) {
    expect(Math.abs(clip.left - before[i].left), `undo did not restore clip ${i} position`).toBeLessThan(0.51);
    expect(Math.abs(clip.width - before[i].width), `undo did not restore clip ${i} length`).toBeLessThan(0.51);
  }

  // ── Redo re-applies it, and the tail is in the same place as before ──────
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.waitForTimeout(500);
  const redone = await geometry(page);
  for (const [i, clip] of redone.entries()) {
    expect(Math.abs(clip.left - after[i].left), `redo diverged for clip ${i}`).toBeLessThan(0.51);
  }

  console.info(`[ripple] jsErrors=${jsErrors.length}`);
  expect(jsErrors, jsErrors.join(" | ")).toHaveLength(0);
});
