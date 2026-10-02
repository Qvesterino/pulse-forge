import { expect, test } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * 14 — LOCAL INTENT MODEL ACTIVATION (2026-10-01 release gate pass).
 *
 * The gate-passed ONNX intent head is DEFAULT ON: boot with no storage
 * keys and the IntentPanel chip must reach `ready` (manifest probe →
 * worker load of the 6.75 MB artifact → provider registration). The
 * explicit `off` opt-out keeps the chip dark with no load attempt.
 *
 * The load is bounded by the loader's own 120 s cold-load budget; the
 * artifact and the ORT wasm binary both come from this origin (dev server
 * serves public/ as-is), so the test is offline-safe.
 */

const CHIP = "button[aria-label^='Local intent model:']";
const INTENT_TAB = "button[aria-label='Toggle intent panel']";

/** openHouseTemplate seeds pf-intent-opened=1 (keeps the A2 auto-open out
 * of generic flows) — this spec WANTS the panel. At default e2e viewports
 * the INTENT toggle lives in the topbar's "⋯" overflow (same as the
 * 02-panel-toggles spec's EXPORT/MIDI), so open the menu first. */
async function openIntentPanel(page: import("playwright/test").Page): Promise<void> {
  await openHouseTemplate(page);
  const direct = page.locator(INTENT_TAB).first();
  // The toggle can exist but live hidden in the overflow menu — probe
  // VISIBILITY, not presence (a detached/hidden match would click nothing).
  if (!(await direct.isVisible())) {
    await page.getByRole("button", { name: /more topbar controls/i }).click();
  }
  await page.locator(INTENT_TAB).first().click();
}

test.describe("14 — local intent model activation", () => {
  test("default boot: the gate-passed model reaches READY", async ({ page }) => {
    await openIntentPanel(page);
    const chip = page.locator(CHIP).first();
    await expect(chip).toBeVisible({ timeout: 60_000 });
    // off → loading → ready. The 6.75 MB fetch + ORT wasm init on a dev
    // server lands in seconds; the loader's own budget is 120 s.
    await expect.poll(async () => chip.getAttribute("data-state"), { timeout: 120_000 }).toBe("ready");
    await expect(chip).toHaveAttribute("aria-label", "Local intent model: ready");
  });

  test("explicit OFF opt-out keeps the chip dark (no load attempt)", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("pf:intent-model", "off");
    });
    await openIntentPanel(page);
    const chip = page.locator(CHIP).first();
    await expect(chip).toBeVisible({ timeout: 60_000 });
    // The off state is synchronous — the loader never probes the manifest.
    await expect.poll(async () => chip.getAttribute("data-state"), { timeout: 30_000 }).toBe("off");
    // Cross-reload persistence of the opt-out is pinned by the loader unit
    // test (setIntentModelMode("off") stores an explicit key); this spec
    // covers the browser-visible half.
  });
});
