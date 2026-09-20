import type { Page } from "playwright/test";

/**
 * Click a topbar panel action whether it is direct or collapsed into the
 * "⋯" overflow menu (the topbar spends its width budget by priority, so on
 * narrower viewports lower-priority panels live behind the overflow trigger).
 *
 * Mirrors the local copy in scripts/verify-browser.mjs. Kept separate so the
 * standalone smoke script keeps its own version and the Playwright specs do
 * not drag a scripts/-only import into their world.
 */
export async function clickPanelAction(page: Page, label: string): Promise<void> {
  // The effect-chain panel is called DEV in the current topbar UI; retain the
  // FX alias in test scenarios because the rack itself is still the FX dock.
  const actionLabel = label === "FX" ? "DEV" : label;
  const direct = page.locator(`.topbar button:has-text("${actionLabel}")`).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  const trigger = page.locator('button[aria-label^="More topbar controls"]').first();
  await trigger.click();
  await page.locator(`#topbar-overflow-menu button:has-text("${actionLabel}")`).first().click();
  // Close the menu so the next action starts from a clean state.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
}

/**
 * Walk the first-run onboarding tour if it is currently showing. Each spec
 * opens the studio fresh, so the tour may or may not appear depending on the
 * persisted `pf-tour-v1` flag. The wait is defensive — the card mounts ~600 ms
 * after the studio finishes rendering, and a slow dev server can stretch it.
 */
export async function completeOnboardingTourIfPresent(page: Page): Promise<void> {
  const tour = await page.waitForSelector(".tour-card", { timeout: 5000 }).catch(() => null);
  if (!tour) return;
  for (let s = 0; s < 3; s += 1) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll<HTMLButtonElement>(".tour-card button"));
      btns.find((b) => b.textContent?.includes("NEXT"))?.click();
    });
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>(".tour-card button"));
    btns.find((b) => b.textContent?.includes("LET'S FORGE"))?.click();
  });
  await page.waitForSelector(".tour-card", { state: "detached", timeout: 5000 });
}

/**
 * Drive the app from the landing page (or the project browser for returning
 * visitors) into the studio with the House template mounted. Returns once the
 * sequencer is rendered and the topbar is interactive.
 */
export async function openHouseTemplateFromLanding(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  // First-time visitors get the landing page — returning visitors hit the
  // browser straight away. Wait for either before deciding.
  await page.waitForSelector(".landing, .project-browser", { timeout: 60_000 });
  const onLanding = await page.locator(".landing").count();
  if (onLanding > 0) {
    await page.waitForSelector(".landing-hero-player .embed-play", { timeout: 60_000 });
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>(".landing-nav button.landing-btn-primary")?.click(),
    );
  }
  await page.waitForSelector(".project-browser", { timeout: 60_000 });
  await page.evaluate(() => document.querySelectorAll<HTMLElement>(".pb-template")[0]?.click());
  await page.waitForSelector(".topbar", { timeout: 60_000 });
  await page.waitForSelector(".sequencer", { timeout: 60_000 });
  await completeOnboardingTourIfPresent(page);
}

/**
 * Same flow as openHouseTemplateFromLanding but presumes the studio is reached
 * directly via the project browser (no landing CTA). Useful for specs that
 * don't need to re-prove the landing detour.
 */
export async function openHouseTemplate(page: Page): Promise<void> {
  // This helper presumes a RETURNING visitor (project browser directly at "/").
  // Playwright contexts are fresh, so seed the onboarded flag the Entry gate
  // checks — otherwise the first-visit landing page hides .project-browser.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
    } catch {
      /* storage blocked — nothing to seed */
    }
  });
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".project-browser", { timeout: 60_000 });
  await page.evaluate(() => document.querySelectorAll<HTMLElement>(".pb-template")[0]?.click());
  await page.waitForSelector(".topbar", { timeout: 60_000 });
  await page.waitForSelector(".sequencer", { timeout: 60_000 });
  await completeOnboardingTourIfPresent(page);
}
