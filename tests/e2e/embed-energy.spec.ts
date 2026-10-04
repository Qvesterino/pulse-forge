import { test, expect } from "playwright/test";

// The share token is precomputed from createProjectFromTemplate("house") —
// templates are deterministic, and decodeShareCode migrates old codes, so a
// token baked here keeps loading across template/schema evolution. (Built at
// runtime it would drag the ESM lz-string import through playwright's node
// loader, which cannot resolve it.)
const HOUSE_CODE =
  "N4IgzgxgFgpgtgQwGowE5gJYHsB2IBcAjIQDQgYAmBIADqlgFYwQAuAtAgKwQDMPADABYA7G2F8ARm0GcKnNhIoAmfmwBmSisIoA2CUohC1IMjgRwY1ABJYArmBgACAEIwELEyAk04BQksEyFgwLAGUMAHMzFltUS3xQHFsLVHcsVAJAkAoYHCw4DGj0zIBfINSIAGswAgBtUEpqFgrK6UIJCR4lNVFBNR4IaUFBHTYATgkADkJ1fkIdHJhhTk4ez0rCqnxs1GTPMwtqABFduBqyCIRCgn4AOjGyGgQ8fH4yOFsWeLUEABsHMhgLC-LAEH7-GCPBAUGr4erkLYgZoIKptDpdHrSfqDYYjcZTGZqOYLGBLFaYp4UNhzfbmeIgADSGCqjiOpJongQYAcLAAkoifqx0gBPW4bKq3RYci5XF6kWjPG6PDAsaBKkAfL5gv4A8DA0H4cG66BYSowADi9FsHKIZQaiORqME7U63V62KGeIm01m80Wy1Wokp1KUtMO2yZLIACrYcGqyFyefzqIKWCKxczKrcaLH4yBLtciFCXm9aCq1a93p9vjrIXqQdqIWQTWbLXYbYQ7Qimi00a7MX0Bp7Rt7CcT-eSg9DqTww-TI5VHAAVZhQPKc7kwPkClFp1Ci8VZr7Qdcywvyp4l5WqqDqzU1pv1g1Gusti1WjtdxrbR2tZ3ot0sSHXERwJX0STJQM2GDIQ52oAAlEINyTHchX3W5UBCW5oAwaV81lPxi3VGhy1vSsNWrRtdSBBtDVrZsoFNd92wIJJfl+L8HV7f9+3dYDhlAn0iT9UkAwpad+E4ODtlCMw4mQrdk22VN0zAOSYFuRBrjPOUiPIkibzvSi6MfGjn3okA3zba1WNsdjOJ7FE-xdDE+JxAT8SE8dRMnaCJJ0aSQFkhA4mXSIoA8BNN23FNd1U9TbmCCIIs8AtdIVK8y0M8j7youszLyhimOsm02I4kh7Ucp0XMAwd3K9MDhIgsSpypfhhECgBhX4EDwxNFNQvdRQgHqaE0gidMIjLiNIoytRM6j9UKyzGNbD9bPsirux-biaoHD0QM8scRMg8S2smQLQigBAzQyKKUNitDRTAa7btuIE1Ei-Dzz00sDIrUtcoW-KluBoq1pY-AyocnanL7VygPqwTjua3yYLGQKrHcRxuqwBwqHugbHqG25rpYbCQXx1KCKLab9NmnLjJfQFQeZlbivW-AlBhpFdoA-b+IaryTpavyqUIfhMex0IsE+hSYuUuL0LJim8ZgCh3tlr60puW4dF+68Aarea2YKsH2YhmyuZ5394dqg6PNHcCJyg4NiCllhHAAeRoXJ5aUkAVOV9xbiwX28Em2nLxm7LAaZiyzbZqzOe5rbv15uGeIRurhyO52fNd6d-ECxCcn9wb00wnJs0KCJqZ+um-oZuOTYT1mLOTyHobTrjM72tzc6dpqXbOthCFnUw6WoJd8kcAAZLAAHdy+J9M0zgW4QWXyOL0VenY+Nh9FtopPVuYq3u8q2Hqv5gfDqH7zTtasfBECme4EcKxwpXxWnsS-JSbfx3gbLKRsKKt1Mu3R8ncL52XKlfDON9eKI0Ho1R+os3ZSUnuGEAS5Mw-0DkrUUvtUAQESvgyOdxhAgP+mRFuR8QYnw7mfEqG14HbUQc5W+KD75oJFmjIuAVsH0mcL8XCBCg7ELQGQiQYi8I6yjnvJuB9wEMJZkw6BLDObQwALpkBgGoNQzAWCwlqHo8AuQYQEGACUG2vYdBjB0BAMYkwKBqHUJMTQ0hNCqBcRASY6gDGcEmGMTghAYASEEKGMgGwcCIkKGAZoyRchfQSUkiwOAPDbEmPwC6wjqA5Lyd9EstxJicBAUDU2UDqLmBoL8GASkypQlSGcax2RmAIGFLrB4oCoAnDDrrLIOY4x0MeLmKAeDwx3H4PrEAlQ8hVHVBETCWTSwjXwa8W4PByk7AwAAN3iHcJQOyIhiLLpsngWQKAYESUuYUvt1RgFsBIXW2ygi4EOVsk5NM7hlJlPNeUcBcAGkBVgCgABBUIpC7xgvBUcRJMKIXgrgKs94YLnBQogIi5w8KsmgooM4ZFqKNRgrnmoLA8F3DxFTiAAxRjWCmPMQ4OJsIbF2LhjwSY+hDEUAQOMBAEh5AiGUGwHJCAeCiuEM4nQwgyRyBeTEzY1A0mnBSZ4FVyTMnUGeH8LAdd8nbE6oxVAVjKGlJ2dHRmEDj7mVMrU+pjS4HNPMKykAeMIDgoIEoMg7rnBTV9WyGIOB4g9KeRIOeMADm-F1t6kAeQbkwAjVG3WQhmyfFlsYfAnAVCljiECMwcZ4iEC2Wi85pYzTCl-K8sgFBMIHPVGoDAvwvioAAKI4D2YMsgsYbm4CmmAOgbgtill+OSyl80R3ktCMKOM6pR1YDZDQFgoyQDuBYE5FNqb2kQE6TGrITzEk-JLbSjtbIepdPIrkPZNhfjDoTFdXqhya0PoeeRVAL6n3ZAXgMt9MB6lck+bG+pyb8Bj0BrCzFiK4UIpyrCol2LIOwYJbiqaQKCXwaQ2SilVKvVlFpYY4xjLASWNZbY8xTwWAtpwKYhBFGqPjH4IK-gYwpVsD0GMGA3iNCis6GMNgEBCByEMRxpQOTCCBSjGutAOBHCesBF8GgnU7BaqILM+gi9XW2yzvbQWyN85PzFtScTcI7ihJIG8Cz5n7jlMsxZ6z5mHN2bM7Z8xWn+48Mdnw1Ghc2qhhM45gLtnAvBYs65vmyCc68OFt50e-BZz+aC4lkLIWwt924ZFzz0WR7P1ggl5LSWCvmdS0g7ODshYo2y4ZySdRCu1fy8VrhEWyt6eHgXWLAU8t1a60V8oaWmu6bzq1gzMEOqdcc7cah3WqE2ccw1u2AskaDfQQI86NX8vrYK3N7TC3UFZbazljGnXbgzds8dkLZ3EvHZs1t9zGXyv6YwUXSWY2pv1d6yVnTi2H78J82PYztRXtdduIEfgN30vNaWz90excXsbY22D-rX2vOVbdvFgHcPAcI9KwN77MXn6EFfrDwHgWsefd2xV-bhnCBSSJxjlL73GvY6R3t4bgi1vE9qzovDeQviafsY45xrj3FqE8VSKJFBfGTH8YEtQwTQnhMiX5+E6ceecbUIICAsvBN8sII4mYghJg8BmBIBA6shgIB0O1fQhAuCWENmRUT8mQrEooLEdw2AXgBFLFGrAEAVQXtMzzVXbBRPj2EGMQTCglDCCUEMIckSdCjGEIIGAnAlgR-VwgDG9uvWTCd6gLJPBLc1rd8EPtXNBDe7-b7-3uthBB6wF8Ng2bDGJ8EHyyYUuhX9CpAgAnfGEBqEE+rpQMAdB+k8LQggRv89ZMcaWV3qQy+e8r2QH3fuWAB-uA3pvAlTdGIlUoDjOJLeDAkKngJghQndEIM4iPUrJ8M0d+AddBe-DDAX6Xj3XrV8gHX7XzZSYEoObTlblNQXlflQVaQbQWPMVCVSYKVRxWVZYeVOoBBYPDQYQHQIkQwakLQKQA3YQdxC3WVBQCAATBAGQP0cfR-bKYvF-Z3dURfd3cvL3NfavDfLfTgHfTjfgNQS3KJdXUVfxdxA3XAyJZYakMAiPA3BABAaJXpAgHQHgWfJgr-Vg3-f-TfQZVOdAxvTjLPSYGAJQOQzjbNOYaQGVeA4QPvfjDjCgS5FYCQBYV+HPfAGVVQ8iZg5fH-KvEETgwZHgtgCgQgBA1PQQCVNQCAcfaQCAYJDgceQYMpTxHQTgfgEwgTYwNw+gw9N-fAefEvJfb-CvPwmvbQzZbgnuagYPPQJYdqCXUVMYATaQBAYQKQMYAwGYaVPgkI7QCXAmRQ9wlQhgvIgo7IdQlfUogIzZKJII5YZPAnTvUVFEAgig8YCI1QIQRjMYZ0fgZxOQ2gisDwkYufeg7w4otgv-DggAu4QQYAsjBMVgfZGASTSjaTAOOjaTBjJjFjQYdjTjQQ2A3jfjQTVYNQETMTTwSAXIGAGjDhaE4NNgPgCgEYTgHgAEowvlEQPY8YAQQQMQG3TQbNEwlQLBONKebYNsLAetKEN41AHAD4qTek74tI34tjCQDjLjIEngPjATITcE4wyEsgQoL4ajG4ibYAhMVAVIHACIeANVBISyOROE9OdZGgEPZYMYXQEQAkgwOPGYCYHgKkS3EwgQPQPgsYCecACAGEgOBEzjZE1E9E6QTE6AnEy0oQAk+QuQJQEk6rWfZwEKOdXICIZdQM9AUoLnd4EKW6Ija0mE8FdNRAHwuEcxBAJMlgl4MxMgedOMxACAegFUxEfM+gdQCWJYVIzjCYKIoYWXRowgUQATZwvQG3dXcAwKI4eCAAVQAFlQhPA9k-hbBPkdlEAaASJZSizqAxz+NJgBJojRDJIxdjCRw+CZhlD+CtBPFBAKApdPBfwA43Nwccdkd9tJ8QpzBqAdYEwgVYxVk9Z7iqjtgSysA2AIlE9z85C7Cr9pAHC+MWMVhgick1B9BeUYB+ADFApCVQh+y18hyRzozxza4pznzeo2MjFPElAug2MCcAT1YAkuVyCkT0ivdZVeAUT9yWhDz+cnEXE3EPEvFxdJdpcjFZcQkwkIkolzyWkryJpV1byVM7gdBHyEEXz+NoRlCJBddxgNBRgU9+AqQWNb9ZyNzwKNAJcFCDh6QeyuzQheROoBz4LdZRzeoJyIgUKNQ0LJgURPEsCqRZBPSRBKDcSlApBwTxUYBx5BM5yFCDze5URQDuhwC+UxgBUhUYDRV+BxVJVpVkDZBOAFUFQeLthrz+LlN7zhKozRKURSzDEjdZdo8xA0iJV28OiEjjl1BTdQilBqcZUOhAoAB1XkI4JcKwQy34Yc4yxCsyiymclYAYcPcPYQ6cCI6cToUkMeQ3RQeQ2-GAOcyipyaijlLlIKiA0KqA4VWAqK6w2KuVBK7iy87YaOG89K15bgrncxOIGIekiyq62IHAJEsJRYw3MeNPS-LlPjSYdXCVHQboFYEIigG0jjdYJVbYO6+kkuSNNARKhRUzfRAjBlNAjhNQAAD3408tT24D4ytxKotxmHkMxE105R3IoFJu6AQH3PuXpDiAOVQESokHuX6i2DZieBaVdRyB3QvSUFuFjUHRyHPS9VLDTGDSUP4DFprVqVrlFvFuyAwEMXsGKLuFHLBTOveAwBRr8DIx5nBoep2NN04A6PcTiKWGgMkIkCtw4HanBME0tL0CxUVTiWoB1o7L-V3TNT+Xw3pRMSRvTlRubwljKQgB-JCQbOkAgsUst1GBFxY2jsr08SyKRCpuoH5rdq8EZs3GZoslZpdTaWCHDB4GWEBBnSxXpllKjFwDrnIiMXVhN0WRmPeRFvwErxloKA1ttBEo4R1pD24EMByCpE6GcsEAkCIIY1CXGCDokDiKipUHVxBsdrBq3HusCgADkABNHGfIeRI9D2ulQjH2gUNGuLSekCkek3doLEZgYQ1ytjQwOa0JTgGw9qSm19SyTevNIEO6NOp4DO5abO1pRU5dPNRiW9AgEPLIIokFUsNdDdTZMW+UOIf9BwXWfwGJYNeIWZHIY8PcR5CAKwGgTNFQQECAHssFT9SAQMuJKwAALyULSKgfTXgj-TcCQZyhuhgCtkBnVs1vuPMUQESTQDaT4ZbXNBpnlBtKbVriOBeVA3lDEQKBbXbQFXqS2CSVfDkRIUUdkXVmWnXV9k0eUZ0cfROGeNVo1DAH0e0fNjOB7MoBEcLEBjAHCByDscyg6rUDACXBCjlKyRfjIBN25BIbyAsczsfH8bAECawAADE4gABHPwQh-MDqmAYJggVRoIJtFgKRudOwCgYNbkJcTCOALJ14PDAoa5NpXIJRyxtmHIPZZkBpRETwWtZII1Z4YNaNciDVDJFgVpnAdp9Ucgns0y5CuocxZpuAZe-QoZm0bM3pVwOJSlWU6lPDAstwL4CFLJEAFQJQUYCWakQQJcYgLmHQLmbmtIwgAALU8GtF5XWfBU2e2d2c2IOaOZ2dOeOzmCuZKCAA";

/**
 * Interactive beats — the /embed ENERGY slider (src/embed/energy.ts).
 *
 * The share page must render the authored beat, start playback, then finish
 * the two background variant renders (dark + bright) and let the listener
 * ride energy from the slider AND over the kyx:* postMessage API — with the
 * visible read-out and the play state tracking both paths.
 */
test.describe("embed — interactive energy", () => {
  // Playwright's Windows WebKit build has no media stack (no AudioContext /
  // OfflineAudioContext at all — see playwright.config.ts), so the offline
  // renders this scenario drives cannot run there. Real Safari-on-macOS
  // audio behavior stays the documented manual owner gate.
  test.skip(({ browserName }) => browserName === "webkit", "Windows WebKit ships without the media stack");
  test("renders, plays, enables the energy slider and rides it", async ({ page }) => {
    test.setTimeout(180_000);
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto(`/embed/#p=${HOUSE_CODE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Authored render completes → play becomes clickable.
    const play = page.locator('button[aria-label="Play"]');
    await expect(play).toBeEnabled({ timeout: 90_000 });
    await play.click();
    await expect(page.locator('button[aria-label="Pause"]')).toBeVisible();

    // The energy row exists while the variants calibrate, then unlocks.
    const slider = page.locator('.embed-energy input[type="range"]');
    await expect(slider).toBeVisible();
    await expect(slider).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator(".embed-energy-value")).toHaveText(/%$/);

    // Ride to full energy through the native control (React onChange).
    await slider.evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(el, "100");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator(".embed-energy-value")).toHaveText("100%");

    // The postMessage API reaches the same control.
    await page.evaluate(() => window.postMessage({ type: "kyx:energy", value: 0 }, "*"));
    await expect(page.locator(".embed-energy-value")).toHaveText("0%", { timeout: 10_000 });
    await page.evaluate(() => window.postMessage({ type: "kyx:pause" }, "*"));
    await expect(page.locator('button[aria-label="Play"]')).toBeVisible({ timeout: 10_000 });

    expect(consoleErrors).toEqual([]);
  });
});
