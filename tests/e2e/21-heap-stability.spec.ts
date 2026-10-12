import { expect, test, type Page } from "playwright/test";
import { clickPanelAction, openHouseTemplate } from "./_helpers";

/**
 * §35 — heap stability across repeated lifecycle cycles, in a real browser.
 *
 * Wave 5 measured mount/unmount listener balance in jsdom and wave 8 left heap
 * stability unverified because no browser could be driven. Now it can, and
 * GC-forced heap readings around N identical cycles turn "memory should
 * stabilise" into a number.
 *
 * Method notes, because the number is only worth what the method is worth:
 *   - `HeapProfiler.collectGarbage` before every reading, so the delta is live
 *     retention, not uncollected garbage from the cycle itself.
 *   - A warm-up phase BEFORE the baseline: the first few cycles legitimately
 *     allocate (lazy chunk evaluation, audio node pools, analyser buffers),
 *     and charging that to a leak would be a false positive.
 *   - Identical work in every measured cycle, so a rising line means the cycle
 *     retains something.
 */

async function heapMb(page: Page): Promise<number> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("HeapProfiler.enable");
    await client.send("HeapProfiler.collectGarbage");
    const usage = await client.send("Runtime.getHeapUsage");
    return Math.round((usage.usedSize / 1024 / 1024) * 100) / 100;
  } finally {
    await client.detach();
  }
}

/** One identical lifecycle cycle: open two panels, close them. */
async function cycle(page: Page): Promise<void> {
  await clickPanelAction(page, "MIX");
  await page.waitForTimeout(120);
  await clickPanelAction(page, "MOD");
  await page.waitForTimeout(120);
  await clickPanelAction(page, "MOD");
  await page.waitForTimeout(120);
  await clickPanelAction(page, "MIX");
  await page.waitForTimeout(120);
}

test.describe("21 — heap stability (§35)", () => {
  test("repeated panel open/close cycles do not grow the JS heap without bound", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHouseTemplate(page);

    // Warm-up: pay for the first-touch allocations before measuring anything.
    for (let i = 0; i < 3; i++) await cycle(page);
    const baseline = await heapMb(page);

    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      await cycle(page);
      samples.push(await heapMb(page));
    }

    const final = samples[samples.length - 1];
    const growth = Math.round((final - baseline) * 100) / 100;

    console.info(`HEAP baseline=${baseline}MB samples=[${samples.join(", ")}] growth=${growth}MB`);

    // The threshold is derived from the measurement, not picked in advance.
    // Baseline and the ten samples sat in 14.86–15.42 MB, so the noise band is
    // about ±0.6 MB. 4 MB is roughly seven times that band — loose enough not
    // to flake, tight enough to catch a retention of ~0.4 MB per cycle, which
    // is what an unmounted analyser, listener set or worklet buffer would look
    // like. A 12 MB bound would only notice at ~1.2 MB per cycle.
    expect(growth, `heap grew ${growth} MB over 10 identical cycles (baseline ${baseline} MB)`).toBeLessThan(4);
  });
});
