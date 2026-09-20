import { test, expect } from "playwright/test";
import { openHouseTemplateFromLanding } from "./_helpers";

test.describe("01 — landing to studio", () => {
  test("defers core audio services until the visitor enters the studio", async ({ page }) => {
    const serviceRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (/\/(?:src\/)?services(?:-[^/]*)?\.(?:ts|js)$/.test(pathname)) {
        serviceRequests.push(pathname);
      }
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /describe it/i })).toBeVisible();
    // The page load event includes statically imported entry dependencies; the
    // preview may finish its own asynchronous render later.
    expect(serviceRequests).toEqual([]);

    await page.getByRole("button", { name: "Open the studio", exact: true }).click();
    await expect(page.getByRole("heading", { name: "NEW PROJECT" })).toBeVisible();
    await expect.poll(() => serviceRequests.length).toBeGreaterThan(0);
  });

  test("first-time visitor walks landing CTA into the studio with the House template", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await openHouseTemplateFromLanding(page);

    // The tour card has either been completed above or it was never shown
    // (returning visitor). Either way, no stale tour is hanging around.
    await expect(page.locator(".tour-card")).toHaveCount(0);

    // The topbar must expose an interactive control: PROJECTS, transport, or
    // an overflow trigger. Pick the most stable anchor.
    const backToBrowser = page.locator('button[aria-label="Back to project browser"]');
    await expect(backToBrowser).toBeVisible();

    // Filter the same AudioContext/autoplay noise the smoke script tolerates.
    const fatal = consoleErrors.filter((e) => !/AudioContext|autoplay|user gesture/i.test(e));
    expect(fatal, `unexpected console errors: ${fatal.slice(0, 3).join(" | ")}`).toEqual([]);
  });

  test("landing prompt forges a beat, opens the studio with it and pre-fills INTENT (A1+A2)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.waitForSelector(".landing-prompt", { timeout: 60_000 });

    // One sentence is the whole funnel: type → forge.
    await page.fill(".landing-prompt-input", "dark trap 140");
    await page.getByRole("button", { name: "Forge it" }).click();

    // Generation is real (client-side intent engine); the preview player
    // enables once the offline render of the forged beat completes.
    const openInStudio = page.getByRole("button", { name: /open in studio/i });
    await expect(openInStudio).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".landing-prompt .landing-hero-player .embed-play")).toBeEnabled({
      timeout: 60_000,
    });

    // Carry the beat into the studio through the handoff (skips the browser).
    await openInStudio.click();
    await page.waitForSelector(".topbar", { timeout: 60_000 });

    // A2: the intent panel opened by default, pre-filled with the prompt
    // that produced the beat now loaded in the project.
    await expect(page.locator(".intent-textarea")).toHaveValue("dark trap 140");
  });
});
