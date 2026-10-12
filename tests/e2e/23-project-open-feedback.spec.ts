import { expect, test, type Page } from "playwright/test";

/**
 * Project-open feedback + double-open guard (editor audit D18).
 *
 * `openDoc` in `src/main.tsx` used to fire `openProject` and forget it. Because
 * the project browser stays mounted until the studio screen commits, the whole
 * studio build ran behind a fully interactive browser: clicking a project gave
 * the user no acknowledgement at all, and any second click in that window
 * started a SECOND `openProject` whose loser was never `closeProject()`-ed — no
 * final save, AudioContext still open.
 *
 * `openProject` only awaits something lazily when `?collab=` is present (the yjs
 * runtime is ~300 KB and deliberately not in the boot path), so that is the
 * honest way to make the window large enough to assert on.
 */

const OPENING_TEXT = /opening studio/i;

async function seedReturningVisitor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
      localStorage.setItem("pf-intent-opened", "1");
    } catch {
      /* storage blocked - nothing to seed */
    }
  });
}

test.describe("project open", () => {
  test("choosing a project leaves the browser immediately, even when the studio build is slow", async ({ page }) => {
    await seedReturningVisitor(page);

    // Make the studio build genuinely slow: openProject awaits the collab
    // runtime chunk when ?collab= is present. Delay it past the assertion.
    const DELAY_MS = 6_000;
    await page.route("**/assets/CollabSession-*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      await route.continue();
    });

    await page.goto("/?collab=audit-room", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });

    const clicked = Date.now();
    await page.locator(".pb-template").first().click();

    // The contract: the project browser must be GONE well before the studio
    // build could possibly have finished. Without the "opening" screen the
    // browser simply sits there for the whole DELAY_MS.
    await expect(page.locator(".project-browser")).toHaveCount(0, { timeout: 2_000 });
    const leftBrowserMs = Date.now() - clicked;
    console.log(`[open] project browser left the screen after ${leftBrowserMs}ms (build stalls ${DELAY_MS}ms)`);
    expect(leftBrowserMs).toBeLessThan(DELAY_MS);

    // ...replaced by something that says what is happening.
    await expect(page.getByText(OPENING_TEXT)).toBeVisible({ timeout: 5_000 });

    // And it still lands in the studio - the warning is not a dead end.
    await page.waitForSelector(".topbar", { timeout: 60_000 });
    await page.waitForSelector(".sequencer", { timeout: 60_000 });
  });

  test("a failed open reports the error instead of leaving an inert screen", async ({ page }) => {
    await seedReturningVisitor(page);

    // Break the studio chunk itself: the import rejects, and the boot machine
    // must surface it rather than sit on a loader.
    await page.route("**/assets/App-*.js", async (route) => {
      await route.abort("failed");
    });

    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });

    // The template click still resolves; what must not happen is silence.
    await page.locator(".pb-template").first().click();
    await expect(page.locator(".boot-error, .panel-error, .crash-screen")).toBeVisible({ timeout: 30_000 });
  });
});
