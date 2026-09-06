import { preview } from "vite";
import { chromium } from "playwright";

const server = await preview({ preview: { port: 5227, host: "127.0.0.1", strictPort: true } });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:5227/", { waitUntil: "networkidle" });
// Landing or studio boot — either proves the chunk graph loads.
const text = await page.evaluate(() => document.body.innerText.slice(0, 200));
await page.screenshot({ path: "scratch/preview-smoke.png" });
console.log("PAGE:", text.replace(/\n/g, " | ").slice(0, 150));
console.log("PAGE_ERRORS:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
await server.close();
process.exit(errors.length === 0 ? 0 : 1);
