import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto("http://localhost:5173/?studio", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
// Whatever page we're on, route into the studio.
const openStudio = page.locator('button:has-text("Open the studio")');
if (await openStudio.isVisible().catch(() => false)) {
  await openStudio.click();
  console.log("clicked Open the studio");
}
await page.waitForTimeout(6000);
const probe = await page.evaluate(() => ({
  masterMeter: document.querySelectorAll(".master-meter").length,
  spectrogram: document.querySelectorAll(".spectrogram").length,
  topbar: Array.from(document.querySelectorAll(".topbar button")).map((b) => (b.textContent || "").trim()).slice(0, 24),
}));
console.log(JSON.stringify(probe, null, 1));
await page.screenshot({ path: "tmp-spectro-shots/0b.png" });
await browser.close();
