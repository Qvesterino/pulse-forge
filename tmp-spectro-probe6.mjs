import { chromium } from "playwright";
const ctx = await chromium.launchPersistentContext("tmp-spectro-profile", {
  headless: true,
  viewport: { width: 1600, height: 900 },
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
let opened = false;
for (let i = 0; i < 40 && !opened; i++) {
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => ({
    masterMeter: document.querySelectorAll(".master-meter").length,
    openStudio: Array.from(document.querySelectorAll("button")).some((b) => /open the studio/i.test(b.textContent || "")),
    house: Array.from(document.querySelectorAll("button")).some((b) => /^HOUSE/i.test((b.textContent || "").trim())),
    continueBtn: Array.from(document.querySelectorAll("button")).some((b) => /CONTINUE LAST PROJECT/i.test(b.textContent || "")),
  }));
  if (state.masterMeter > 0) { opened = true; break; }
  if (state.continueBtn) { await page.locator('button:has-text("CONTINUE LAST PROJECT")').first().click().catch(() => {}); console.log(i, "click continue"); continue; }
  if (state.openStudio) { await page.locator('button:has-text("Open the studio")').first().click().catch(() => {}); console.log(i, "click open studio"); continue; }
  if (state.house) { await page.locator('button:has-text("HOUSE")').first().click().catch(() => {}); console.log(i, "click HOUSE"); continue; }
}
if (!opened) {
  console.log("NOT OPENED; dumping buttons:");
  console.log(await page.evaluate(() => Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").trim().slice(0, 30)).slice(0, 30)));
  await page.screenshot({ path: "tmp-spectro-shots/stuck.png" });
} else {
  console.log("STUDIO OPEN");
  const probe = await page.evaluate(() => ({
    spectrogram: document.querySelectorAll(".spectrogram").length,
    mixerish: Array.from(document.querySelectorAll("div[class]"))
      .map((d) => d.className)
      .filter((c) => /mixer|dock/i.test(c))
      .slice(0, 8),
  }));
  console.log(JSON.stringify(probe));
  await page.screenshot({ path: "tmp-spectro-shots/studio.png" });
}
await ctx.close();
