import { expect, test, type Page } from "playwright/test";
import { openHouseTemplate } from "./_helpers";

/**
 * §17 — playback, measured in a real browser against the production build.
 *
 * Waves 6–8 could not run this check: the dev server never finished its cold
 * transform and the in-app Browser lost its control channel, so "playback
 * editing / ghost audio" stayed unverified for the whole audit. The production
 * build boots in ~2 s and is drivable through Playwright, so the check can
 * finally be made instead of argued.
 *
 * What counts as evidence here, and what does not:
 *
 *   - The transport clock moving proves the scheduler ticked. It does NOT prove
 *     anything was audible — a scheduler advances over an empty graph too.
 *   - The master strip's peak readout proves signal reached the MASTER bus.
 *     `MasterStereoMeters` renders `.master-channel-peak-readout` straight from
 *     the engine's master stereo snapshot, in dB, with `-∞` (U+2212 infinity)
 *     for silence. That is the strongest DOM-observable evidence available
 *     without reaching into engine internals.
 *   - The per-track meters (`Meter.tsx` → `role="meter"`, `aria-valuenow` 0-100)
 *     corroborate that the signal exists upstream of the master, not just at it.
 *   - A master readout that stays finite AFTER stop is the ghost-audio case the
 *     objective names: a stuck voice, a released buffer, or a meter that never
 *     falls. The House template is drums + bass + chords, so a stuck source is
 *     plausible rather than hypothetical.
 */

const SILENCE_DB = -119;

/** Master L/R peak readouts in dB; -Infinity when the bus is silent. */
async function readMasterDb(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".master-channel-peak-readout")).map((el) => {
      const raw = (el.textContent ?? "").replace(/−/g, "-").replace(/[^\d.-]/g, "");
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }),
  );
}

/** Per-track / per-bus meter positions, 0–100, straight off the DOM. */
async function readTrackMeters(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="meter"]')).map((el) =>
      Number(el.getAttribute("aria-valuenow") ?? "0"),
    ),
  );
}

test.describe("20 — playback reaches the master bus (§17)", () => {
  test("playing the House template produces master signal and stopping releases it", async ({ page }) => {
    test.setTimeout(120_000);

    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`.slice(0, 200)));
    page.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`.slice(0, 160)));

    await page.setViewportSize({ width: 1440, height: 900 });
    await openHouseTemplate(page);

    const readouts = await page.locator(".master-channel-peak-readout").count();
    expect(readouts, "master stereo meters not mounted — the mixer strip is the probe surface").toBeGreaterThan(0);

    // 1 — Baseline: nothing is playing, the master bus must be silent. A meter
    // already hot here is leftover state from project open — the "ghost audio"
    // class this test exists to catch.
    await page.waitForTimeout(700);
    const beforeDb = await readMasterDb(page);
    expect(Math.max(...beforeDb), `master not silent before playback: ${beforeDb} dB`).toBeLessThanOrEqual(SILENCE_DB);

    // 2 — Transport start.
    await page.locator(".btn-play").click();
    const positionBefore = (await page.locator(".position-display").textContent())?.trim();

    // 3 — Sample the master bus while the transport runs.
    let peakDb = Number.NEGATIVE_INFINITY;
    let trackPeak = 0;
    const timeline: number[] = [];
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(200);
      const db = await readMasterDb(page);
      const meters = await readTrackMeters(page);
      const maxDb = Math.max(...db);
      timeline.push(Number.isFinite(maxDb) ? Math.round(maxDb * 10) / 10 : -999);
      peakDb = Math.max(peakDb, maxDb);
      trackPeak = Math.max(trackPeak, ...meters);
    }

    const positionDuring = (await page.locator(".position-display").textContent())?.trim();

    // 4 — Transport stop, then watch the bus fall back to silence.
    await page.locator(".btn-stop").click();
    const afterDb: number[] = [];
    for (let i = 0; i < 14; i++) {
      await page.waitForTimeout(250);
      afterDb.push(Math.max(...(await readMasterDb(page))));
    }

    console.info(
      `PLAYBACK readouts=${readouts} position ${positionBefore} -> ${positionDuring} ` +
        `peakDb=${peakDb} trackPeak=${trackPeak} timeline=${timeline.join(",")} ` +
        `afterStopMax=${Math.max(...afterDb)} afterStopLast=${afterDb[afterDb.length - 1]} ` +
        `errors=${consoleErrors.length} failedRequests=${failedRequests.slice(0, 4).join(" | ") || "none"}`,
    );

    // The transport actually ran.
    expect(positionDuring, "position display missing").toBeTruthy();
    expect(positionDuring, `transport did not advance: ${positionBefore} -> ${positionDuring}`).not.toBe(
      positionBefore,
    );

    // Signal reached the master bus — and it existed upstream too.
    expect(peakDb, `no master signal during playback (timeline: ${timeline.join(",")})`).toBeGreaterThan(SILENCE_DB);
    expect(trackPeak, "no signal on any track meter during playback").toBeGreaterThan(0);

    // Nothing is left ringing once the transport stops.
    expect(
      afterDb[afterDb.length - 1],
      `master still hot after stop: ${afterDb.map((d) => Math.round(d * 10) / 10).join(",")}`,
    ).toBeLessThanOrEqual(SILENCE_DB);

    // AudioContext noise is tolerated (same filter the landing spec uses).
    //
    // Connection failures are NOT filtered blind. This environment serves the
    // studio from `vite preview` and runs no collab/gallery server, so refused
    // requests are expected — but only to hosts other than the page's own
    // origin. A refused SAME-ORIGIN request means the app failed to load one of
    // its own assets, which is a real regression and must stay red.
    const pageOrigin = new URL(page.url()).origin;
    const ownAssetFailures = failedRequests.filter((entry) => entry.startsWith(pageOrigin));
    expect(ownAssetFailures, `the app failed to load its own assets: ${ownAssetFailures.join(" | ")}`).toEqual([]);

    const fatal = consoleErrors.filter(
      (e) => !/AudioContext|autoplay|user gesture/i.test(e) && !/ERR_CONNECTION_REFUSED|ERR_ABORTED/i.test(e),
    );
    expect(fatal, `unexpected console errors: ${fatal.slice(0, 3).join(" | ")}`).toEqual([]);
  });
});
