/**
 * Probe the running KYX app for the selectors the capture script needs.
 * Run against `vite preview` of the production build.
 *
 * Usage: node scripts/probe-kyx-ui.mjs [--url http://localhost:4173]
 */
import { chromium } from "playwright";

const URL_ARG = process.argv.indexOf("--url");
const BASE = URL_ARG !== -1 ? process.argv[URL_ARG + 1] : "http://localhost:4173";

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(6000);

const report = await page.evaluate(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const inputs = [...document.querySelectorAll("input, textarea, [contenteditable]")].map((el) => ({
    tag: el.tagName,
    type: el.getAttribute("type"),
    placeholder: el.getAttribute("placeholder"),
    aria: el.getAttribute("aria-label"),
    visible: vis(el),
  }));
  const buttons = [...document.querySelectorAll("button")]
    .filter(vis)
    .slice(0, 40)
    .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 34));
  const landmarks = {
    canvas: document.querySelectorAll("canvas").length,
    audio: document.querySelectorAll("audio").length,
    headings: [...document.querySelectorAll("h1,h2,h3")].filter(vis).map((h) => h.textContent.trim().slice(0, 40)).slice(0, 20),
  };
  return { inputs, buttons, landmarks, title: document.title };
});

console.log("TITLE:", report.title);
console.log("\nINPUTS:", JSON.stringify(report.inputs, null, 2));
console.log("\nBUTTONS:", JSON.stringify(report.buttons, null, 2));
console.log("\nLANDMARKS:", JSON.stringify(report.landmarks, null, 2));
console.log("\nERRORS:", errors.slice(0, 6));

await page.screenshot({ path: "D:/pulse-forge/scratch/kyx-probe.png" });
await browser.close();
