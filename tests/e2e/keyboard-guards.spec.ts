import { expect, test, type Page } from "playwright/test";

import { openArrangement } from "./_studio";

/**
 * §18 KEYBOARD SHORTCUTS vs FOCUSED CONTROLS — "destructive shortcuts must not
 * fire while typing in unrelated controls", with the positive control that
 * makes the negative meaningful.
 *
 * The panel's own SECS field is the sharpest case available: it is a
 * `type="number"` input that lives inside the arrangement toolbar, so every
 * global key handler in `App.tsx` is a candidate to steal keys from it. A
 * Delete or Backspace pressed there is an ordinary editing keystroke; a clip
 * vanishing at that moment is data loss caused by focus, not by intent.
 *
 * Every negative assertion below is paired with a positive control. "Delete
 * does nothing while typing" is worthless on its own — it is equally satisfied
 * by a Delete shortcut that is broken everywhere. The control asserts the same
 * key DOES remove a clip once the field has lost focus.
 */

const clipCount = (page: Page) => page.locator(".arr-clip").count();

test("destructive shortcuts are inert while a panel field has focus", async ({ page }) => {
  const jsErrors: string[] = [];
  page.on("pageerror", (e) => jsErrors.push(`pageerror: ${e.message}`));

  await openArrangement(page);

  // The SECS field only exists for a selected clip — that is the precondition
  // under which a destructive key would have something to destroy.
  await page.locator(".arr-clip").first().click();
  await page.waitForTimeout(200);
  const secs = page.getByRole("spinbutton", { name: "Clip length in seconds" });
  await expect(secs, "the SECS field must exist for a selected clip").toBeVisible();

  const before = await clipCount(page);

  // ── Typing ───────────────────────────────────────────────────────────────
  await secs.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("12");
  await page.waitForTimeout(150);
  console.info(`[keys] typed=${await secs.inputValue()} clips=${await clipCount(page)}`);
  expect(await clipCount(page), "typing digits must not remove a clip").toBe(before);

  // ── Delete / Backspace INSIDE the field ──────────────────────────────────
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  expect(await clipCount(page), "Delete pressed inside a text field must not delete the selected clip").toBe(before);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  expect(await clipCount(page), "Backspace inside a text field must not delete a clip").toBe(before);

  // ── Ctrl+Z inside the field ──────────────────────────────────────────────
  // The field's Escape reverts its draft; undo would restore the deleted clip,
  // so "clip count grew" is the tell-tale of an undo leaking through focus.
  const beforeUndo = await clipCount(page);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  expect(await clipCount(page), "Ctrl+Z inside a text field must not reach the project undo stack").toBe(beforeUndo);

  // ── Escape reverts the draft without committing ──────────────────────────
  await secs.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("99");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await clipCount(page), "Escape in the field must not remove or resize anything").toBe(before);
  await page
    .locator(".arr-lane")
    .first()
    .click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);
  console.info(`[keys] afterEscape fieldValue=${await secs.inputValue()}`);

  // ── POSITIVE CONTROL ─────────────────────────────────────────────────────
  // Same viewport, same session, focus off the field: Delete must now work.
  // Without this line every assertion above would also pass on a build where
  // the Delete shortcut does nothing at all.
  await page.locator(".arr-clip").first().click();
  await page.waitForTimeout(200);
  const beforeControl = await clipCount(page);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(400);
  const afterControl = await clipCount(page);
  console.info(`[keys] control: ${beforeControl} -> ${afterControl}`);
  expect(afterControl, "Delete must remove a clip when the field does NOT have focus").toBeLessThan(beforeControl);

  expect(jsErrors, jsErrors.join(" | ")).toHaveLength(0);
});
