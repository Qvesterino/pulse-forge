import type { Page } from "playwright/test";

/** Panel label (test vocabulary) → the dock tab's stable aria-label.
 * FX keeps its historical alias — the devices tab has been the FX dock's
 * test-facing name since the rack was renamed DEV. */
const DOCK_TAB_ARIA: Record<string, string> = {
  MIX: "Toggle mixer panel",
  FX: "Toggle track device chain",
  DEV: "Toggle track device chain",
  ARR: "Toggle arrangement and scenes",
  MOD: "Toggle modulation panel",
  EXPORT: "Toggle export panel",
  DICE: "Toggle dice panel",
  INTENT: "Toggle intent panel",
  MIDI: "Toggle MIDI input panel",
  REF: "Toggle reference map panel",
};

/** Resolve a panel label to its dock tab locator. The tab row is always
 * mounted (ROADMAP-UI-2027 V1) — no direct-vs-overflow dance anymore. */
export function dockTabLocator(page: Page, label: string) {
  const aria = DOCK_TAB_ARIA[label];
  if (!aria) throw new Error(`unknown panel label: ${label}`);
  return page.locator(`.dock-tabs button[aria-label="${aria}"]`).first();
}

export async function clickPanelAction(page: Page, label: string): Promise<void> {
  await dockTabLocator(page, label).click();
}

/** Read a dock tab's open state (aria-selected on the tab role). */
export async function panelOpen(page: Page, label: string): Promise<boolean> {
  return (await dockTabLocator(page, label).getAttribute("aria-selected")) === "true";
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
  // The A2 default-open INTENT panel is exercised by the dedicated landing
  // forge spec; these generic helpers seed the flag so the dozens of specs
  // built on them keep the classic default dock (MIXER in slot A).
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-intent-opened", "1");
    } catch {
      /* storage blocked — nothing to seed */
    }
  });
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
  // pf-intent-opened keeps the A2 auto-open out of these generic flows (the
  // dedicated landing forge spec covers it).
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
      localStorage.setItem("pf-intent-opened", "1");
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
