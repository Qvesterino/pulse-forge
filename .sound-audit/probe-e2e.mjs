import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  localStorage.setItem("pf-onboarded", "1");
  localStorage.setItem("pf-intent-opened", "1");
});
await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".project-browser", { timeout: 90000 });
await page.evaluate(() => document.querySelectorAll(".pb-template")[0]?.click());
await page.waitForSelector(".topbar", { timeout: 90000 });
await page.waitForTimeout(1500);
let tab = await page.$("button[aria-label='Toggle intent panel']");
console.log("direct tab:", tab ? "present" : "absent");
if (!tab) {
  await page.getByRole("button", { name: /more topbar controls/i }).click();
  await page.waitForTimeout(400);
  tab = await page.$("button[aria-label='Toggle intent panel']");
  console.log("tab after overflow:", tab ? "present" : "absent");
}
if (tab) {
  await tab.click();
  await page.waitForTimeout(1200);
  const chip = await page.$("button[aria-label^='Local intent model:']");
  console.log("chip:", chip ? await chip.getAttribute("data-state") : "MISSING");
  const ta = await page.$("textarea[aria-label='Intent description']");
  console.log("textarea:", ta ? "present" : "MISSING");
}
await browser.close();
