import { test, expect } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

test.describe("04 — persistence roundtrip", () => {
  test("generated pattern survives JSON export + reload through the browser", async ({ page }) => {
    await openHouseTemplate(page);

    const chips = page.locator(".pattern-chip");
    const before = await chips.count();

    // Generate one new pattern so we have a known delta to assert against.
    await page.locator('.pattern-actions button:has-text("GEN")').click();
    await expect(page.locator('.generate-dialog-backdrop[role="dialog"]')).toBeVisible();
    // Two `.generate-seed-input` exist (SEED and NAME); SEED is the first.
    await page.locator(".generate-dialog input.generate-seed-input").first().fill("e2e-seed");
    // 3rd .generate-select is the LENGTH dropdown (1st = GENRE, 2nd = STYLE).
    await page.locator(".generate-dialog select.generate-select").nth(2).selectOption("32");
    await expect(page.locator(".generate-dialog .preview-grid")).toBeVisible();
    await page.locator('.generate-dialog button:has-text("GENERATE")').click();
    await expect(page.locator('.generate-dialog-backdrop[role="dialog"]')).toHaveCount(0);

    const afterGenerate = await chips.count();
    expect(afterGenerate).toBe(before + 1);

    // Export JSON: capture the download, assert the filename convention.
    await clickPanelAction(page, "EXPORT");
    await expect(page.locator('.export-panel[aria-label="Export"]')).toBeVisible();
    // The JSON export lives in the panel's "more options" disclosure, so the
    // button is not on the panel until that section is opened.
    const moreOptions = page.locator(".export-panel details.export-more-options");
    if (!(await moreOptions.evaluate((el) => (el as HTMLDetailsElement).open))) {
      await moreOptions.locator("summary").click();
    }
    const downloadPromise = page.waitForEvent("download");
    await page.locator('.export-panel button:has-text("EXPORT JSON")').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().endsWith(".kyx")).toBe(true);

    // Allow autosave to settle before reloading the page.
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator(".project-browser")).toBeVisible({ timeout: 30_000 });

    // The library loads asynchronously, so the project may not be on offer
    // the moment the browser renders: wait for it before opening it.
    const continueCard = page.locator(".pb-continue-card").first();
    await expect
      .poll(async () => (await continueCard.count()) + (await page.locator(".pb-row .pb-row-name").count()), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    if ((await continueCard.count()) > 0) {
      await continueCard.click();
    } else {
      // A library row opens by its NAME button - there is no "OPEN" button.
      await page.locator(".pb-row .pb-row-name").first().click();
    }
    await expect(page.locator(".sequencer")).toBeVisible({ timeout: 30_000 });

    const afterReload = await chips.count();
    expect(afterReload, "reload must preserve the generated pattern").toBe(afterGenerate);
  });
});
