import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 150)));
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForSelector('button:has-text("HOUSE")', { timeout: 30000 });
await page.click('button:has-text("HOUSE")');
await page.waitForTimeout(8000);
const probe = await page.evaluate(() => ({
  masterMeter: document.querySelectorAll(".master-meter").length,
  spectrogram: document.querySelectorAll(".spectrogram").length,
  mixer: document.querySelectorAll(".mixer, [class*=mixer]").length,
  topbarButtons: Array.from(document.querySelectorAll(".topbar button")).map((b) => (b.textContent || "").trim()).slice(0, 30),
  bodyClass: document.body.className.slice(0, 100),
}));
console.log(JSON.stringify(probe, null, 1));
await page.screenshot({ path: "tmp-spectro-shots/0-studio.png" });
await browser.close();
