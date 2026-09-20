import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.locator('button:has-text("Open the studio")').first().click();
console.log("clicked open studio");
await page.waitForTimeout(7000);
const probe = await page.evaluate(() => ({
  masterMeter: document.querySelectorAll(".master-meter").length,
  spectrogram: document.querySelectorAll(".spectrogram").length,
  mixer: document.querySelectorAll("[class*=mixer]").length,
  topbar: Array.from(document.querySelectorAll(".topbar button")).map((b) => (b.textContent || "").trim()).slice(0, 24),
}));
console.log(JSON.stringify(probe));
await page.screenshot({ path: "tmp-spectro-shots/0c.png" });
await browser.close();
