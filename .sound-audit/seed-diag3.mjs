import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, logLevel: "error", server: { port: 5233, host: "127.0.0.1", strictPort: true } });
await server.listen();
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch();
const page = await browser.newPage();
const stuck = [];
page.on("request", (req) => stuck.push({ url: req.url().slice(0, 90), t: Date.now() }));
page.on("requestfinished", (req) => {
  const i = stuck.findIndex((s) => s.url === req.url().slice(0, 90));
  if (i >= 0) stuck.splice(i, 1);
});
page.on("requestfailed", (req) => console.log("[failed]", req.url().slice(0, 100), req.failure()?.errorText));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
try {
  await page.goto("http://127.0.0.1:5233/", { waitUntil: "commit", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 12000));
  console.log("readyState:", await page.evaluate(() => document.readyState));
  console.log("STUCK REQUESTS (10s):", JSON.stringify(stuck.slice(0, 6), null, 1));
} catch (err) {
  console.log("FAIL:", String(err).slice(0, 200));
} finally {
  await browser.close();
  await server.close();
}
