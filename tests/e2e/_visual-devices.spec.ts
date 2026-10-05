import { test } from "playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

/**
 * Visual baseline for the bottom-dock DEV panel (ROADMAP-UI-2027 style pass).
 * Not an assertion spec: it captures deterministic screenshots of the device
 * chain strip, the focused device editor and a split view. It is SKIPPED in
 * the normal suite — opt in when re-capturing:
 *
 *   $env:PULSE_VISUAL=1; npx playwright test _visual-devices --project=chromium
 *
 * Output lands in `test-results/visual/` (git-ignored).
 */
const OUT_DIR = resolve(process.cwd(), "test-results", "visual");
mkdirSync(OUT_DIR, { recursive: true });

test.describe("visual — devices dock", () => {
  test.skip(process.env.PULSE_VISUAL !== "1", "visual capture — set PULSE_VISUAL=1");

  test("capture DEV panel states", async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await openHouseTemplate(page);

    await test.step("empty device chain", async () => {
      await clickPanelAction(page, "DEV");
      await page.locator(".devices-panel").waitFor({ state: "visible" });
      await page.locator(".devices-chain").waitFor({ state: "visible" });
      await page.screenshot({ path: resolve(OUT_DIR, "dev-empty.png"), fullPage: false });
    });

    await test.step("single core effect", async () => {
      await page.locator(".devices-add-effect").first().selectOption("eq");
      await page.locator(".fx-device").first().waitFor({ state: "visible" });
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(OUT_DIR, "dev-single.png"), fullPage: false });
    });

    await test.step("multi-effect chain", async () => {
      await page.locator(".devices-add-effect").first().selectOption("compressor");
      await page.locator(".devices-add-effect").first().selectOption("reverb");
      await page.locator(".devices-add-effect").first().selectOption("chorus");
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(OUT_DIR, "dev-chain.png"), fullPage: false });
      await page.locator(".devices-chain").screenshot({ path: resolve(OUT_DIR, "dev-chain-strip.png") });
    });

    await test.step("flagship editor", async () => {
      await page.locator(".devices-add-effect").first().selectOption("ultina");
      await page.waitForTimeout(700);
      await page.screenshot({ path: resolve(OUT_DIR, "dev-ultina.png"), fullPage: false });
    });
  });

  test("capture DEV panel at 1280 and in split view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHouseTemplate(page);
    await clickPanelAction(page, "DEV");
    await page.locator(".devices-panel").waitFor({ state: "visible" });
    await page.locator(".devices-add-effect").first().selectOption("eq");
    await page.locator(".devices-add-effect").first().selectOption("compressor");
    await page.locator(".devices-add-effect").first().selectOption("ultina");
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(OUT_DIR, "dev-1280.png"), fullPage: false });

    // Ctrl+click the MIX tab to land it in the split slot.
    await page
      .locator('.dock-tabs button[aria-label="Toggle mixer panel"]')
      .first()
      .click({ modifiers: ["Control"] });
    await page.locator(".devices-panel").waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, "dev-split.png"), fullPage: false });
  });
});
