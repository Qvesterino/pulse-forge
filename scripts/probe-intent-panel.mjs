/**
 * Probe the studio's IntentPanel: what does the UI actually show after a
 * prompt is submitted? Used to diagnose the NEXUS capture script, which
 * fails when the AUDIOTOOL button does not appear.
 *
 * Usage: node scripts/probe-intent-panel.mjs [--url http://127.0.0.1:5173]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../scratch/intent-probe");
mkdirSync(SHOTS, { recursive: true });

const URL_ARG = process.argv.indexOf("--url");
const BASE = URL_ARG !== -1 ? process.argv[URL_ARG + 1] : "http://127.0.0.1:5173";

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(new URL("/studio", BASE).href, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);

const open = page
  .getByRole("button", { name: /^(open|continue|resume|load|new|blank|empty|house|beat|template)/i })
  .first();
if (await open.count()) {
  try {
    await open.click({ timeout: 4000 });
    await page.waitForTimeout(8000);
  } catch {
    /* already open */
  }
}
await page.screenshot({ path: resolve(SHOTS, "1-studio.png") });

const field = page.locator('input[aria-label="Intent description"], textarea[aria-label="Intent description"]').first();
console.log("intent field count:", await field.count());

if (await field.count()) {
  await field.click();
  await page.keyboard.type("dark trap 140", { delay: 50 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(SHOTS, "2-typed.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(15_000);
}

await page.screenshot({ path: resolve(SHOTS, "3-after-enter.png") });

// What is actually on screen now?
const survey = await page.evaluate(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const buttons = [...document.querySelectorAll("button")]
    .filter(vis)
    .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30))
    .filter(Boolean);
  const panel = document.querySelector(".intent-panel");
  return {
    panelFound: !!panel,
    candidateBlocks: document.querySelectorAll(".intent-candidate").length,
    useButtons: [...document.querySelectorAll(".intent-use-btn")].filter(vis).length,
    buttons: [...new Set(buttons)].slice(0, 45),
    headings: [...document.querySelectorAll("h1,h2,h3,.intent-panel__title")].filter(vis).map((h) => h.textContent.trim().slice(0, 40)).slice(0, 12),
  };
});
console.log(JSON.stringify(survey, null, 2));
console.log("errors:", errors.slice(0, 5));

await browser.close();
