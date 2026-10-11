import { test } from "playwright/test";

/** TEMPORARY probe (deleted after use): does the transport actually run in headless Chromium? */
test("transport advances?", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("pf-onboarded", "1");
    window.localStorage.setItem("pf-tour-v1", "1");
  });
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("button", { name: /start here/i }).first().click({ timeout: 60_000 });
  await page.locator(".dock-tabs").first().waitFor({ state: "attached", timeout: 60_000 });
  await page.locator('.dock-tabs button[aria-label="Toggle arrangement and scenes"]').first().click();
  await page.locator(".arr-lane").first().waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForTimeout(800);

  const read = () =>
    page.evaluate(() => {
      const ph = document.querySelector(".arr-playhead") as HTMLElement | null;
      return {
        playhead: ph ? ph.style.left : "none",
        playingClips: document.querySelectorAll(".arr-clip.playing").length,
        playBtn: (() => {
          const b = Array.from(document.querySelectorAll("button")).find((x) =>
            (x.getAttribute("title") ?? "").startsWith("Play / Pause"),
          ) as HTMLButtonElement | undefined;
          return b ? `${b.textContent}|${b.className}|disabled=${b.disabled}` : "none";
        })(),
      };
    });

  console.info(`[t] before=${JSON.stringify(await read())}`);

  // A: keyboard Space (what a user presses)
  await page.keyboard.press("Space");
  await page.waitForTimeout(700);
  console.info(`[t] afterSpace=${JSON.stringify(await read())}`);
  await page.waitForTimeout(700);
  console.info(`[t] afterSpace2=${JSON.stringify(await read())}`);

  // B: explicit transport click
  await page.getByRole("button", { name: /Play \/ Pause/ }).click();
  await page.waitForTimeout(800);
  console.info(`[t] afterClick=${JSON.stringify(await read())}`);
  await page.waitForTimeout(800);
  console.info(`[t] afterClick2=${JSON.stringify(await read())}`);

  const audio = await page.evaluate(() => {
    const ctxs: string[] = [];
    // @ts-expect-error debug probe
    if (window.__pfAudioCtx) ctxs.push("__pfAudioCtx present");
    return ctxs;
  });
  console.info(`[t] audioProbe=${JSON.stringify(audio)}`);
});