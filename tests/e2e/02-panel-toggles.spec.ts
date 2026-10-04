import { expect, test } from "playwright/test";
import { clickPanelAction, openHouseTemplate, panelOpen } from "./_helpers";

/**
 * The dock owns its own chrome (ROADMAP-UI-2027 V1): every panel has a
 * permanently-mounted tab in the bottom dock's tab row. The toggle contract
 * is aria-selected on the tab — no direct-vs-overflow placement dance, the
 * tab exists in exactly one place at every viewport width.
 */
test.describe("02 — panel toggles", () => {
  test("each dock tab opens and closes (MIX/FX/ARR/MOD/EXPORT)", async ({ page }) => {
    await openHouseTemplate(page);

    for (const label of ["MIX", "FX", "ARR", "MOD", "EXPORT"]) {
      // The initial state is layout-dependent (the default dock opens with
      // MIXER visible). The contract under test is the TOGGLE on the same
      // tab: selected must flip and flip back.
      const initial = await panelOpen(page, label);
      expect(initial, `${label} tab exposes an aria-selected state`).toBeDefined();

      await clickPanelAction(page, label);
      await expect.poll(() => panelOpen(page, label), { timeout: 5000 }).toBe(!initial);

      await clickPanelAction(page, label);
      await expect.poll(() => panelOpen(page, label), { timeout: 5000 }).toBe(initial);
    }
  });

  test("the tab row stays visible with every panel closed (collapsed dock)", async ({ page }) => {
    await openHouseTemplate(page);

    // Close whatever is open until the dock collapses to its tab row.
    for (const label of ["MIX", "FX", "ARR", "MOD", "EXPORT", "DICE", "INTENT", "MIDI"]) {
      if (await panelOpen(page, label)) await clickPanelAction(page, label);
    }
    await expect(page.locator(".dock-tabs")).toBeVisible();

    // And one click reopens a panel from the collapsed state.
    await clickPanelAction(page, "MIX");
    await expect.poll(() => panelOpen(page, "MIX")).toBe(true);
    await expect(page.locator(".dock-slot")).toBeVisible();
  });

  test("a click on a split-slot tab closes it instead of moving it (V0c)", async ({ page }) => {
    await openHouseTemplate(page);

    // Open MIX primary, then Ctrl+click DICE into the split slot.
    if (!(await panelOpen(page, "MIX"))) await clickPanelAction(page, "MIX");
    await page.locator('.dock-tabs button[aria-label="Toggle dice panel"]').click({ modifiers: ["Control"] });
    await expect.poll(() => panelOpen(page, "DICE")).toBe(true);
    await expect(page.locator(".bottom-panels.dock-split")).toBeVisible();

    // Plain click on the split-slot tab CLOSES it — the primary stays.
    await clickPanelAction(page, "DICE");
    await expect.poll(() => panelOpen(page, "DICE")).toBe(false);
    await expect.poll(() => panelOpen(page, "MIX")).toBe(true);
    await expect(page.locator(".bottom-panels.dock-split")).toHaveCount(0);
  });
});
