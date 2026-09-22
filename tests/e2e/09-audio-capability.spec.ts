import { test, expect } from "playwright/test";

/**
 * 09 — audio capability degradation.
 *
 * The studio's one hard dependency is Web Audio. When a browser cannot
 * provide it (old browser, hardened build, iOS Low Power Mode, or Playwright's
 * Windows WebKit which ships without any media stack), the boot must show the
 * friendly guidance screen — never a raw ReferenceError.
 *
 * Scenario layout:
 *  - "stubbed" test runs on EVERY engine: deletes the audio globals before
 *    the app evaluates, then asserts the guidance screen. This is the
 *    regression guard for the degradation path itself.
 *  - the webkit-only test proves the REAL Windows WebKit environment (no
 *    audio at all) degrades gracefully too.
 *  - the chromium-only test guards the happy path: the capability gate must
 *    never false-positive on a fully capable browser.
 */

const GUIDANCE = ".crash-screen";

async function seedReturningVisitor(page: import("playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
      localStorage.setItem("pf-intent-opened", "1");
    } catch {
      /* storage blocked — nothing to seed */
    }
  });
}

test.describe("09 — audio capability", () => {
  test("boot without Web Audio shows actionable guidance instead of a raw crash", async ({ page }) => {
    await page.addInitScript(() => {
      for (const name of ["AudioContext", "OfflineAudioContext"]) {
        try {
          Object.defineProperty(window, name, { get: () => undefined, configurable: true });
        } catch {
          /* engine without the global — already undefined */
        }
      }
    });
    await seedReturningVisitor(page);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });

    const screen = page.locator(GUIDANCE);
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await expect(screen.locator("h1")).toContainText("Web Audio");
    await expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
    // The old failure mode leaked engine internals at the visitor; the
    // guidance screen must not.
    await expect(page.getByText("ReferenceError")).toHaveCount(0);
    await expect(screen.locator("li")).toHaveCount(4);
  });

  test("real WebKit-on-Windows (no media stack) degrades gracefully too", async ({ page, browserName }) => {
    test.skip(browserName !== "webkit", "only Playwright's Windows WebKit lacks Web Audio natively");
    await seedReturningVisitor(page);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const screen = page.locator(GUIDANCE);
    await expect(screen).toBeVisible({ timeout: 30_000 });
    await expect(screen.locator("h1")).toContainText("Web Audio");
  });

  test("a fully capable browser boots the project browser untouched by the gate", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "happy-path guard runs once — on the audio-capable engine");
    await seedReturningVisitor(page);
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator(".project-browser")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(GUIDANCE)).toHaveCount(0);
  });
});
