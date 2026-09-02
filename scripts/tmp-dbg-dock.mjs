import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5312;
const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".project-browser", { timeout: 60_000 }).catch((e) => console.log("PB-WAIT-FAILED:", String(e).slice(0, 120)));
await page.locator('.pb-template:has-text("HOUSE")').first().click();
await page.waitForSelector(".sequencer", { timeout: 60_000 });
await page.waitForTimeout(500);

const first = await page.locator(".step").nth(0).boundingBox();
const fourth = await page.locator(".step").nth(3).boundingBox();
console.log("first:", JSON.stringify(first));
console.log("fourth:", JSON.stringify(fourth));

const probe = await page.evaluate(([x, y]) => {
  const at = (px, py) => {
    const el = document.elementFromPoint(px, py);
    return el ? `${el.tagName}.${String(el.className).slice(0, 40)}` : "null";
  };
  const seq = document.querySelector(".sequencer");
  return {
    atFourth: at(x, y),
    seqRect: seq ? JSON.stringify(seq.getBoundingClientRect()) : "none",
    dockH: getComputedStyle(document.documentElement).getPropertyValue("--dock-height"),
    dockRect: JSON.stringify(document.querySelector(".bottom-panels")?.getBoundingClientRect?.() ?? {}),
  };
}, [fourth.x + fourth.width - 5, fourth.y + fourth.height / 2]);
console.log("probe:", JSON.stringify(probe));

await page.mouse.move(first.x + 5, first.y + first.height / 2);
await page.keyboard.down("Shift");
await page.mouse.down();
await page.mouse.move(fourth.x + fourth.width - 5, fourth.y + fourth.height / 2, { steps: 6 });
await page.mouse.up();
await page.keyboard.up("Shift");
const selected = await page.locator(".step.in-selection").count();
console.log("SELECTED:", selected);

await browser.close();
await server.close();
process.exit(0);
