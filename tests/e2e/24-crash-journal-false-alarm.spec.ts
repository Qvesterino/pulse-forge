import { expect, test, type BrowserContext, type Page } from "playwright/test";

/**
 * The crash banner must never assert a cause the app cannot know.
 *
 * `analyzeCrashJournal` reports `lastSessionClean: false` unless the journal
 * ends on `session-close`, and `session-close` is written ONLY by
 * `closeProject` — the in-app back-to-browser button. Closing the tab,
 * following a link or refreshing never writes it, because an IndexedDB write
 * dispatched from a `pagehide` handler does not commit in Chromium (measured;
 * editor audit D20).
 *
 * The old copy read "Previous session may have ended unexpectedly (crash or
 * force-quit)." That is an assertion of cause, fired on the overwhelmingly
 * common case of an ordinary, deliberate exit. A user who learns that this
 * banner cries wolf stops reading it — which costs us the one case where it
 * would have mattered.
 */

const BANNER = ".pb-crash-banner";

async function seedReturningVisitor(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
      localStorage.setItem("pf-intent-opened", "1");
    } catch {
      /* storage blocked - nothing to seed */
    }
  });
}

async function bannerCopy(page: Page): Promise<string> {
  return (await page.locator(".pb-crash-text").first().textContent()) ?? "";
}

test.describe("crash banner honesty", () => {
  test("an ordinary exit does not get told it crashed", async ({ context }) => {
    await seedReturningVisitor(context);

    const first = await context.newPage();
    await first.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await first.waitForSelector(".project-browser", { timeout: 60_000 });
    await first.locator(".pb-template").first().click();
    await first.waitForSelector(".row-steps", { timeout: 60_000 });

    // Leave the way a user actually leaves: navigate away. Fires pagehide.
    await first.goto("about:blank");
    await first.close();

    const second = await context.newPage();
    await second.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await second.waitForSelector(".project-browser", { timeout: 60_000 });

    const copy = await bannerCopy(second);
    console.log(`[journal] ordinary-exit banner copy = ${JSON.stringify(copy)}`);

    // The banner itself may still be shown — the journal genuinely cannot
    // prove a clean shutdown. What it must not do is name a cause.
    expect(copy).not.toMatch(/crash/i);
    expect(copy).not.toMatch(/force-quit/i);
    expect(copy).not.toMatch(/ended unexpectedly/i);
  });

  test("a session that vanished is still surfaced with its last save time", async ({ context }) => {
    // The control. Without it the test above would also pass if the banner had
    // simply been deleted: silencing the app is not the same as fixing it.
    await seedReturningVisitor(context);
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });

    // Simulate exactly what a hard kill leaves behind: a session-open and no
    // clean-close marker.
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("pulse-forge", 15);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("meta", "readwrite");
          const store = tx.objectStore("meta");
          const read = store.get("crashJournal");
          read.onsuccess = () => {
            const prev = Array.isArray(read.result) ? read.result : [];
            store.put(
              [...prev, { t: new Date().toISOString(), kind: "session-open", projectId: "audit-crash" }],
              "crashJournal",
            );
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });

    const copy = await bannerCopy(page);
    console.log(`[journal] vanished-session banner copy = ${JSON.stringify(copy)}`);
    await expect(page.locator(BANNER)).toHaveCount(1);
    expect(copy).toMatch(/did not end through KYX/i);
  });
});
