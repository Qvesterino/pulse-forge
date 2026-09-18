import { expect, type Page, test } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

/**
 * Read the panel action's aria-pressed from whichever instance is currently
 * attached: direct topbar buttons (MIX/FX/ARR/MOD at common widths) or the
 * lazily-rendered overflow menu (EXPORT/MIDI wait there on narrow viewports).
 * The direct locator alone would hang on overflow-resident panels — the
 * button does not exist in the DOM while the menu is closed.
 */
async function pressedOf(page: Page, label: string): Promise<boolean | null> {
  const direct = page.locator(`.topbar button:has-text("${label}")`).first();
  if (await direct.isVisible().catch(() => false)) {
    return (await direct.getAttribute("aria-pressed").catch(() => null)) === "true";
  }
  const trigger = page.locator('button[aria-label^="More topbar controls"]').first();
  if (!(await trigger.isVisible().catch(() => false))) return null;
  await trigger.click();
  const item = page.locator(`#topbar-overflow-menu button:has-text("${label}")`).first();
  const pressed = await item.getAttribute("aria-pressed").catch(() => null);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  if (pressed !== "true" && pressed !== "false") return null;
  return pressed === "true";
}

test.describe("02 — panel toggles", () => {
  test("each topbar panel opens and closes (MIX/FX/ARR/MOD/EXPORT)", async ({ page }) => {
    await openHouseTemplate(page);

    for (const label of ["MIX", "FX", "ARR", "MOD", "EXPORT"]) {
      // The initial state is layout-dependent (the default dock opens with
      // MIXER visible; EXPORT may live only in the overflow). The contract
      // under test is the TOGGLE on the same action: pressed must flip and
      // flip back, wherever the button currently lives.
      const initial = await pressedOf(page, label);
      expect(initial, `${label} exposes an aria-pressed state`).not.toBeNull();

      await clickPanelAction(page, label);
      // poll: the read itself re-resolves direct-vs-overflow placement, so a
      // panel animation or a transient menu state cannot fail the flip check.
      await expect
        .poll(() => pressedOf(page, label), { timeout: 5000 })
        .toBe(!initial);

      await clickPanelAction(page, label);
      await expect.poll(() => pressedOf(page, label), { timeout: 5000 }).toBe(initial);
    }
  });
});
