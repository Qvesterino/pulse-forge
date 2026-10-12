import { expect, test, type BrowserContext, type Page } from "playwright/test";

/**
 * Editor audit D20 — OPEN P1, MEASURED, NOT YET FIXED.
 *
 * `installSaveUnloadGuards` answers BOTH `visibilitychange`→hidden and
 * `pagehide` with `flushSave()`, precisely so an edit still inside the 800 ms
 * autosave debounce is not lost when the tab goes away.
 *
 * Measured in Chromium against the production build:
 *
 *   BASELINE (template, no click) ......... stored step 0.95
 *   CONTROL  (click, idle 3 s) ........... stored step 0     — saved
 *   UNLOAD   (click, close the tab) ....... stored step 0.95  — EDIT LOST
 *
 * and both unload events really do fire (verified with synchronous
 * localStorage markers in each handler): the page is not skipping the guards,
 * the IndexedDB transactions those guards start simply never commit before
 * the document is torn down. A synchronous `localStorage` write in the same
 * handler DOES survive, which is what proves the ordering.
 *
 * So the safety net provides a false sense of protection: the only thing
 * actually protecting the user's last edit today is the autosave window
 * (`debounceMs: 800`, `maxDeferMs: 5000`), i.e. up to ~5 s of work can be
 * silently lost on an ordinary tab close.
 *
 * The remediation is an OWNER DECISION (audit report D20): either shorten the
 * autosave window (cheap, but multiplies IndexedDB writes) or add a
 * synchronous crash-recovery buffer plus a restore flow (real feature, real
 * scope). Until then the test stays skipped rather than red — a knowingly red
 * spec would break the suite for everyone, and the evidence lives in
 * `EDITOR_QUALITY_AUDIT_REPORT.md` wave 16 and `docs/CURRENT-STATE.md`.
 *
 * BASELINE and CONTROL below are NOT skipped: they pin the fixture the skipped
 * test depends on, so if the first template's opening step ever changes, they
 * fail loudly here instead of letting the skipped test quietly become
 * meaningless.
 */

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

/**
 * Read the first step of the first pattern straight out of the persisted
 * project — the ground truth the user would see on their next visit.
 * `Pattern` stores `rows: Record<ID, number[]>`, not `steps`.
 */
async function firstStepPersisted(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("pulse-forge", 15);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const docs = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction("projects", "readonly");
      const req = tx.objectStore("projects").getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    const doc = docs[docs.length - 1] as { patterns?: { rows?: Record<string, number[]> }[] } | undefined;
    const rows = doc?.patterns?.[0]?.rows;
    if (!rows) return null;
    const firstRowId = Object.keys(rows)[0];
    const step = firstRowId === undefined ? undefined : rows[firstRowId]?.[0];
    return typeof step === "number" ? step : null;
  });
}

async function openTemplateAndToggleFirstStep(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".project-browser", { timeout: 60_000 });
  await page.locator(".pb-template").first().click();
  await page.waitForSelector(".row-steps", { timeout: 60_000 });
  await page.locator(".row-steps button").first().click();
}

test.describe("unload save flush (D20)", () => {
  test("BASELINE: the untouched template's own value, with no click at all", async ({ context }) => {
    // The first step of the first template ships ON, at velocity 0.95, and
    // clicking toggles it OFF. Every assertion below is relative to this.
    await seedReturningVisitor(context);
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".project-browser", { timeout: 60_000 });
    await page.locator(".pb-template").first().click();
    await page.waitForSelector(".row-steps", { timeout: 60_000 });
    await page.waitForTimeout(3000); // let the create-save land

    const step = await firstStepPersisted(page);
    console.log(`[flush] BASELINE untouched template step = ${step}`);
    expect(step).toBe(0.95);
  });

  test("CONTROL: an edit left alone is saved", async ({ context }) => {
    // Proves the step click really does dirty the document and reach storage,
    // so the skipped test below is measuring loss and not a no-op edit.
    await seedReturningVisitor(context);
    const page = await context.newPage();
    await openTemplateAndToggleFirstStep(page);
    await page.waitForTimeout(3000);

    const step = await firstStepPersisted(page);
    console.log(`[flush] CONTROL persisted first step = ${step}`);
    expect(step).toBe(0);
  });

  test("an edit inside the autosave debounce is recovered after an ordinary tab close", async ({ context }) => {
    // D20: the unload flush itself does not commit, so this edit IS lost from
    // IndexedDB — that part of the defect is unchanged. What must happen now is
    // that it survives in the synchronous recovery buffer and comes back.
    await seedReturningVisitor(context);
    const page = await context.newPage();
    await openTemplateAndToggleFirstStep(page);

    await page.goto("about:blank");
    await page.close();

    const second = await context.newPage();
    await second.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await second.waitForSelector(".project-browser", { timeout: 60_000 });

    // The raw save still did not happen - that is the defect, unchanged.
    const stepBeforeRecovery = await firstStepPersisted(second);
    console.log(`[flush] stored step before recovery = ${stepBeforeRecovery}`);

    const raw = await second.evaluate(() => {
      try {
        return window.localStorage.getItem("kyx:recovery-buffer:v1");
      } catch {
        return "THREW";
      }
    });
    console.log(`[flush] buffer present = ${raw !== null}, length = ${raw === null ? 0 : raw.length}`);

    // ...but the Project Browser offers the work back.
    const recover = second.getByRole("button", { name: /^Recover$/ });
    await expect(recover).toBeVisible({ timeout: 15_000 });

    await recover.click();
    await second.waitForSelector(".row-steps", { timeout: 60_000 });
    await second.waitForTimeout(2500); // let the recovered save commit

    const stepAfterRecovery = await firstStepPersisted(second);
    console.log(`[flush] stored step after recovery = ${stepAfterRecovery}`);
    expect(stepAfterRecovery).toBe(0);
  });
});
