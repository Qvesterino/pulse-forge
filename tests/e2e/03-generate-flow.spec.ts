import { test, expect } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

test.describe("03 — generate pattern flow", () => {
  test("GEN adds a pattern, undo/redo roundtrip restores it", async ({ page }) => {
    await openHouseTemplate(page);

    const chips = page.locator(".pattern-chip");
    const before = await chips.count();

    await page.locator('.pattern-actions button:has-text("GEN")').click();
    await expect(page.locator('.generate-dialog-backdrop[role="dialog"]')).toBeVisible();

    // Two `.generate-seed-input` exist (SEED and NAME); SEED is the first.
    await page.locator(".generate-dialog input.generate-seed-input").first().fill("e2e-seed");
    // 3rd .generate-select is the LENGTH dropdown (1st = GENRE, 2nd = STYLE).
    await page.locator(".generate-dialog select.generate-select").nth(2).selectOption("32");
    await expect(page.locator(".generate-dialog .preview-grid")).toBeVisible();
    await page.locator('.generate-dialog button:has-text("GENERATE")').click();
    await expect(page.locator('.generate-dialog-backdrop[role="dialog"]')).toHaveCount(0);

    const after = await chips.count();
    expect(after, "generation must add one pattern chip").toBe(before + 1);

    await page.locator('button[aria-label="Undo"]').click();
    await expect.poll(() => chips.count(), { timeout: 5000 }).toBe(before);

    await page.locator('button[aria-label="Redo"]').click();
    await expect.poll(() => chips.count(), { timeout: 5000 }).toBe(after);
  });
});
