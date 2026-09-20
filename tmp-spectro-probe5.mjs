import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const openBtn = page.locator('button:has-text("Open the studio")');
if ((await openBtn.count()) > 0) {
  await openBtn.first().click();
  console.log("landing -> clicked open studio");
}
await page.locator('button:has-text("HOUSE")').first().click({ timeout: 30000 });
console.log("clicked HOUSE");
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(4000);
  const probe = await page.evaluate(() => ({
    masterMeter: document.querySelectorAll(".master-meter").length,
    spectrogram: document.querySelectorAll(".spectrogram").length,
    seq: document.querySelectorAll("[class*=sequencer]").length,
    labels: Array.from(document.querySelectorAll(".topbar button, [class*=topbar] button"))
      .map((b) => (b.textContent || "").trim().slice(0, 14))
      .slice(0, 26),
  }));
  console.log(`t=${(i + 1) * 4}s`, JSON.stringify(probe));
  if (probe.masterMeter > 0) break;
}
await page.screenshot({ path: "tmp-spectro-shots/0e.png" });
await browser.close();
