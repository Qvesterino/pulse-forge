import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "info",
  optimizeDeps: { noDiscovery: true },
  server: { port: 5233, host: "127.0.0.1", strictPort: true },
});
await server.listen();
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
try {
  await page.goto("http://127.0.0.1:5233/", { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("LOADED OK, title:", await page.title());
} catch (err) {
  console.log("GOTO FAIL:", String(err).slice(0, 200));
} finally {
  await browser.close();
  await server.close();
}
