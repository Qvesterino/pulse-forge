import { test, expect } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

test.describe("02 — panel toggles", () => {
  test("each topbar panel opens and closes (MIX/FX/ARR/MOD/EXPORT)", async ({ page }) => {
    await openHouseTemplate(page);

    for (const label of ["MIX", "FX", "ARR", "MOD", "EXPORT"]) {
      // Open
      await clickPanelAction(page, label);
      await page.waitForTimeout(150);
      // The panel action's aria-pressed should now read "true" on the same
      // button — that is the canonical "panel is visible" signal in the
      // topbar contract.
      const btn = page.locator(`.topbar button:has-text("${label}")`).first();
      const pressed = await btn.getAttribute("aria-pressed").catch(() => null);
      // The button may live in the overflow menu on narrow viewports; that's
      // fine — the same aria-pressed semantics apply.
      expect(pressed, `${label} should be open (aria-pressed=true)`).toBe("true");

      // Close
      await clickPanelAction(page, label);
      await page.waitForTimeout(100);
      const pressedAfter = await btn.getAttribute("aria-pressed").catch(() => null);
      expect(pressedAfter, `${label} should be closed (aria-pressed=false)`).toBe("false");
    }
  });
});
