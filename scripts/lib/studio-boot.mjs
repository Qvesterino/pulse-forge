/**
 * studio-boot.mjs — open the studio, once, for every measuring script.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four gates each grew their own copy of the boot sequence. That duplication
 * already cost a real outage: on 2026-10-20 a commit in the app renamed the
 * first-run template marker (`pb-template-start` → `pb-template`, and the
 * "START HERE" hint went with it), and every gate that waited on
 * `button.pb-template-start` timed out at once — 40 minutes of "the harness
 * broke" across four scripts, all from one class name. A measurement tool
 * whose entry point is copied four times is a measurement tool that breaks
 * four times.
 *
 * WHAT IT DOES
 * ------------
 * 1. Skips the landing page.
 * 2. Warms vite's dependency optimizer and reloads, so a mid-load forced
 *    reload cannot land after the project is opened.
 * 3. Opens a project — the continue card when a project exists, otherwise the
 *    House template. The templates live inside a `<details>` that is CLOSED on
 *    a fresh profile, so the disclosure is opened first. That detail is the
 *    one that actually broke above: the template button existed in the DOM
 *    but was not visible, and a `waitFor({ state: "visible" })` on it timed
 *    out.
 * 4. Waits for the studio chrome, refuses to measure a crash screen, and
 *    closes the first-run tour.
 *
 * It THROWS when the studio does not come up. A caller must never continue
 * past a failed boot and report a measurement of an empty document.
 */

/**
 * @param {import("playwright").Page} page
 * @param {string} url
 * @param {{ label?: string, waitMs?: number }} [options]
 * @returns {Promise<string>} how the project was opened, for the log line
 */
export async function bootStudio(page, url, options = {}) {
  const { label = "", waitMs = 480_000 } = options;

  // Skip the landing page: this measures the studio shell, not onboarding.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
    } catch {
      /* storage blocked - the landing shows, handled below */
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });

  // WARM THE OPTIMIZER BEFORE MEASURING. Observed 2026-10-18: partway through
  // the first load vite logged "new dependencies optimized:
  // @huggingface/transformers / optimized dependencies changed. reloading" and
  // force-reloaded the page AFTER the project was opened, so the studio chrome
  // never came up and the run died as a navigation timeout. The log line is
  // the evidence; "cold transform" was the excuse for two sessions.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "domcontentloaded" });

  const how = await enterProject(page);

  // `main.tsx` lazy-imports the studio only once a project is open.
  await page.locator(".topbar, .crash-screen, .boot-error").first().waitFor({ state: "visible", timeout: waitMs });
  await page.waitForTimeout(1200);

  // A boot that settled on an error screen is a real result, not a timeout to
  // hide behind - surface it instead of measuring an empty document.
  const crashed = page.locator(".crash-screen, .boot-error").first();
  if ((await crashed.count()) > 0) {
    const text = (await crashed.innerText()).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`studio boot did not settle: ${text}`);
  }

  // The first-run tour overlays the shell and would shift every measurement.
  // It is a dismissible overlay, not part of the layout under test.
  const skipTour = page.locator("button:has-text('SKIP')").first();
  if ((await skipTour.count()) > 0 && (await skipTour.isVisible().catch(() => false))) {
    await skipTour.click().catch(() => {});
    await page.waitForTimeout(400);
  }

  if (label) console.log(`${label} booted once: ${how}`);
  return how;
}

/**
 * Open a project from the browser screen.
 *
 * Order matters: a stored project wins when it exists (the continue card),
 * because resuming a real project is closer to how the studio is actually
 * used than creating a fresh one.
 */
async function enterProject(page) {
  const continueCard = page.locator("button.pb-continue-card");
  if ((await continueCard.count()) > 0 && (await continueCard.isVisible().catch(() => false))) {
    await continueCard.first().click();
    return "resumed last project";
  }

  // The templates live inside a <details> that is closed on a fresh profile:
  // the button is in the DOM but NOT visible, and waiting for visibility on it
  // is what used to time out.
  const templates = page.locator(".pb-templates .pb-template");
  try {
    await templates.first().waitFor({ state: "attached", timeout: 60_000 });
  } catch (error) {
    // A bare Playwright timeout says "some locator did not appear" and leaves
    // the reader guessing whether the app crashed, the dev server was still
    // compiling, or the markup changed again. Say what was actually on screen.
    const seen = await page
      .evaluate(() => ({
        url: location.href,
        bodyClass: document.body?.className ?? "",
        crash: !!document.querySelector(".crash-screen, .boot-error"),
        text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
      }))
      .catch(() => null);
    throw new Error(
      `project templates never appeared${seen ? ` (url ${seen.url}, body "${seen.bodyClass}"` + (seen.crash ? ", CRASH SCREEN" : "") + `, text "${seen.text}")` : ""}: ${error.message}`,
    );
  }

  if (!(await templates.first().isVisible().catch(() => false))) {
    // Click the disclosure the way a user would.
    const disclosure = page.locator("details:has(.pb-templates)").first();
    await disclosure.locator("summary").first().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300);
    // Fallback for the case where React re-asserts its `open` prop: set the
    // attribute directly. This is a measurement harness, not a user gesture.
    if (!(await templates.first().isVisible().catch(() => false))) {
      await page.evaluate(() => {
        for (const d of document.querySelectorAll("details")) {
          if (d.querySelector(".pb-templates")) d.open = true;
        }
      });
      await page.waitForTimeout(300);
    }
  }

  if (!(await templates.first().isVisible().catch(() => false))) {
    throw new Error("project templates are present but not visible and could not be revealed");
  }

  // `house` is the FIRST entry of TEMPLATES (src/project-model/templates.ts),
  // so the first button is the House template the studio opens with.
  await templates.first().click();
  return "opened House template";
}
