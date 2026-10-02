import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  localStorage.setItem("pf-onboarded", "1");
  localStorage.setItem("pf-intent-opened", "1");
});
await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".project-browser", { timeout: 60000 });
await page.evaluate(() => document.querySelectorAll(".pb-template")[0]?.click());
await page.waitForSelector(".topbar", { timeout: 60000 });
const buttons = await page.$$eval("button", (els) =>
  els.map((el) => ({ aria: el.getAttribute("aria-label"), text: (el.textContent || "").trim().slice(0, 20) })).filter((b) => b.aria || b.text),
);
console.log("total buttons:", buttons.length); console.log(JSON.stringify(buttons.slice(0,40), null, 0).slice(0, 2000));
await browser.close();
