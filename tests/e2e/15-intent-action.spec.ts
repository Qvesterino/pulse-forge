import { expect, test } from "playwright/test";
import { completeOnboardingTourIfPresent, openHouseTemplate } from "./_helpers";

/**
 * 15 — INTENT → ACTION (the loop the whole intent campaign is about):
 * type a command into the IntentPanel, press ⚡ DO IT, and assert the
 * DOCUMENT actually changed (undo history enabled + status reporting the
 * executed plan), not just a chip lighting up.
 *
 * This exercises the DEFAULT path (the deterministic router — the model is
 * the resolver's fallback provider, see model-loader.ts). Spec 14 proves
 * the model layer registers; this spec proves words become honest,
 * undoable actions.
 */

const PROMPT = "textarea[aria-label='Intent description']";
const DO_IT = "button.intent-route-btn";
const STATUS = ".intent-status";
const INTENT_TAB = "button[aria-label='Toggle intent panel']";

async function openIntentPanel(page: import("playwright/test").Page): Promise<void> {
  await openHouseTemplate(page);
  await completeOnboardingTourIfPresent(page);
  // The INTENT tab lives in the always-mounted dock tab row
  // (ROADMAP-UI-2027 V1): one click, no overflow dance.
  await page.locator(INTENT_TAB).first().click();
  await expect(page.locator(".intent-panel")).toBeVisible({ timeout: 30_000 });
}

async function routeIntent(page: import("playwright/test").Page, text: string): Promise<void> {
  await page.locator(PROMPT).fill(text);
  await page.locator(DO_IT).click();
}

test.describe("15 — intent → action", () => {
  test("mute the drums — the command lands as document state", async ({ page }) => {
    await openIntentPanel(page);
    await routeIntent(page, "mute the drums");
    // The router reports the executed plan ("mute drums") in the status
    // line AND the command is undoable — the undo control enabling is the
    // document-state proof (an unmatched prompt would clarify, not apply).
    await expect(page.locator(STATUS)).toContainText(/mute/i, { timeout: 30_000 });
    await expect(page.locator("button[aria-label='Undo']")).toBeEnabled({ timeout: 30_000 });
  });

  test("transport by words — stop via the intent panel", async ({ page }) => {
    await openIntentPanel(page);
    await routeIntent(page, "stop");
    await expect(page.locator(STATUS)).toContainText(/stop/i, { timeout: 30_000 });
  });
});
