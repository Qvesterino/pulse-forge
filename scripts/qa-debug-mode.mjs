import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5203;

const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();

try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext().then(c => c.newPage());
  page.on("console", (m) => { if (m.type() === "error") console.log(`[err]`, m.text()); });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e)));

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

  console.log("Initial btn-mode text:", await page.textContent(".topbar button.btn-mode"));
  await page.click(".topbar button.btn-mode");
  await page.waitForTimeout(500);
  console.log("After 1st click:", await page.textContent(".topbar button.btn-mode"));

  // Check the rendered HTML to see if React re-rendered
  const html1 = await page.locator(".topbar button.btn-mode").evaluate((el) => el.outerHTML);
  console.log("Button outerHTML after click:", html1);

  await browser.close();
} catch (e) {
  console.error("failed:", e);
} finally {
  await server.close();
}
