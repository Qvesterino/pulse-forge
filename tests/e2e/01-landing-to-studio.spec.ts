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
    await expect(page.getByRole("heading", { name: "Make beats in your browser." })).toBeVisible();
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
});
