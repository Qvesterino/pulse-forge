import { test } from "playwright/test";

/** TEMPORARY probe (deleted after use): dumps the arrangement editing surface. */
test("dump surface", async ({ page }) => {
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

  const dump = await page.evaluate(() => {
    const clip = document.querySelector(".arr-clip") as HTMLElement | null;
    const panel = document.querySelector(".arr-panel") as HTMLElement | null;
    const btn = (el: Element) => {
      const b = el as HTMLButtonElement;
      return `${b.tagName.toLowerCase()}.${(b.className || "").toString().split(" ")[0]}[aria-label=${b.getAttribute("aria-label") ?? "-"}][title=${(b.getAttribute("title") ?? "-").slice(0, 46)}][text=${(b.textContent ?? "").trim().slice(0, 14)}]`;
    };
    return {
      clipHtml: clip ? clip.outerHTML.slice(0, 1400) : "none",
      panelButtons: panel ? Array.from(panel.querySelectorAll("button")).slice(0, 60).map(btn) : [],
      transportButtons: Array.from(document.querySelectorAll("button"))
        .map(btn)
        .filter((s) => /play|stop|record|undo|redo|zoom|snap/i.test(s))
        .slice(0, 30),
      topbarButtons: Array.from(document.querySelectorAll("header button, .topbar button, .transport button")).map(btn).slice(0, 30),
      audioClips: document.querySelectorAll(".arr-audio-clip").length,
      sceneClips: document.querySelectorAll(".arr-clip").length,
      canvasCount: document.querySelectorAll("canvas").length,
    };
  });
  console.info(`[probe] sceneClips=${dump.sceneClips} audioClips=${dump.audioClips} canvases=${dump.canvasCount}`);
  console.info(`[probe] clipHtml=${dump.clipHtml}`);
  console.info(`[probe] panelButtons=\n${dump.panelButtons.join("\n")}`);
  console.info(`[probe] transport=\n${dump.transportButtons.join("\n")}`);
  console.info(`[probe] topbar=\n${dump.topbarButtons.join("\n")}`);
});