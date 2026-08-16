import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5204;

const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();

try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext().then(c => c.newPage());
  page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", String(e), "STACK:", e.stack?.slice(0, 500)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await new Promise((res) => {
      const req = indexedDB.deleteDatabase("pulse-forge");
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".topbar", { timeout: 10000 });
  await page.waitForTimeout(500);

  console.log("--- Before click ---");
  await page.click(".topbar button.btn-mode");
  await page.waitForTimeout(500);
  console.log("--- After click ---");
  await page.click(".topbar button.btn-mode");
  await page.waitForTimeout(500);
  console.log("--- After 2nd click ---");
  await page.click(".topbar button.btn-mode");
  await page.waitForTimeout(500);
  console.log("--- After 3rd click ---");

  await browser.close();
} catch (e) {
  console.error("failed:", e);
} finally {
  await server.close();
}
