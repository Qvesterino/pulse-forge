import { chromium } from "playwright";
import { createServer } from "vite";

const src = (await import("node:fs")).readFileSync("scripts/measure-genre-references.mjs", "utf8");
const start = src.indexOf("const MEASURE_BODY = `");
const end = src.indexOf("`;", start);
const body = new Function(src.slice(start, end + 2) + " return MEASURE_BODY;")();

const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: 5299, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5299/__probe", { waitUntil: "commit" });

const r1 = await page.evaluate(body, { genre: "house", seeds: [], targetLufs: -14 }).then((v) => "OK " + typeof v).catch((e) => "THREW " + String(e).slice(0, 130));
console.log("bare:", r1);
const r2 = await page.evaluate("(" + body + ")", { genre: "house", seeds: [], targetLufs: -14 }).then((v) => "OK " + typeof v + " " + JSON.stringify(v).slice(0, 90)).catch((e) => "THREW " + String(e).slice(0, 130));
console.log("paren:", r2);
await browser.close();
await server.close();
process.exit(0);
