import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.locator('button:has-text("Open the studio")').first().click();
await page.waitForTimeout(2000);
await page.locator('button:has-text("HOUSE")').first().click();
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(5000);
  const probe = await page.evaluate(() => ({
    url: location.hash || location.pathname,
    masterMeter: document.querySelectorAll(".master-meter").length,
    spectrogram: document.querySelectorAll(".spectrogram").length,
    anyButtons: Array.from(document.querySelectorAll("button")).length,
    labels: Array.from(document.querySelectorAll("button")).slice(0, 18).map((b) => (b.textContent || "").trim().slice(0, 16)),
  }));
  console.log(`t=${(i + 1) * 5}s`, JSON.stringify(probe));
  if (probe.masterMeter > 0) break;
}
await page.screenshot({ path: "tmp-spectro-shots/0d.png" });
await browser.close();
