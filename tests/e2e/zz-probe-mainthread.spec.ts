import { expect, test } from "playwright/test";

/**
 * TEMPORARY probe — is the production build's main thread ALIVE after load?
 *
 * Wave 8 left an unexplained split: `open_tab`/navigation reported
 * `loaded: true` in 532 ms against the preview server, and then EVERY
 * operation that touches the page (accessibility snapshot, console
 * diagnostics) hung until the 275 s tool ceiling.
 *
 * A slow boot and a dead renderer look identical from the outside. They are
 * not the same defect, and the difference decides where the fix goes:
 * a slow boot is chunk loading, a dead renderer is an infinite main-thread
 * loop. Playwright is the measuring instrument here because it has its own
 * timeouts, so "the page never answered" becomes a bounded, attributable
 * failure instead of a 275 s wall.
 *
 * Run against the PREVIEW build (PULSE_FORGE_E2E_PORT=4173), not the dev
 * server: Vite's cold module transform dominated every earlier attempt.
 */

const errors: string[] = [];
const console_ = (msg: { type: () => string; text: () => string }) => {
  if (msg.type() === "error") errors.push(msg.text().slice(0, 300));
};

/** Answer the only question that separates "slow" from "dead". */
test("main thread answers evaluate() after the load event", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("console", console_);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));

  // A returning user — skip the landing route.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("pf-onboarded", "1");
    } catch {
      /* storage blocked — the app falls back to the studio anyway */
    }
  });

  // "commit" resolves at navigation start, BEFORE the load event, so the
  // evaluate below races the load instead of waiting behind it.
  const t0 = Date.now();
  await page.goto("/", { waitUntil: "commit", timeout: 30_000 });
  const commitMs = Date.now() - t0;

  // Probe the renderer immediately and repeatedly. If the main thread is
  // blocked, every one of these hangs and the test dies at its own timeout.
  const probes: Array<{ at: number; ok: boolean; detail: string }> = [];
  for (let i = 0; i < 5; i++) {
    try {
      const detail = await Promise.race([
        page.evaluate(() => `${document.readyState}|${document.querySelectorAll("*").length}`),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("probe-timeout")), 8_000)),
      ]);
      probes.push({ at: Date.now() - t0, ok: true, detail });
    } catch (error) {
      probes.push({ at: Date.now() - t0, ok: false, detail: String(error).slice(0, 120) });
      break;
    }
    await page.waitForTimeout(500);
  }

  console.info(
    `PROBE commit=${commitMs}ms ${JSON.stringify(probes)}\nERRORS(${errors.length}): ${errors.slice(0, 12).join(" | ")}`,
  );
  expect(probes.length).toBeGreaterThan(0);
});