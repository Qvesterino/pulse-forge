import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5202;

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

  // Open DIAG
  await page.locator(".topbar button:has-text(\"DIAG\")").click();
  await page.waitForTimeout(1000);
  // Print inner HTML of diagnostics
  const diagHtml = await page.locator(".diagnostics").innerHTML().catch(() => "(not found)");
  console.log("DIAG HTML (first 2000 chars):");
  console.log(diagHtml.slice(0, 2000));
  console.log("---");

  // Try to read rows
  const rows = await page.$$eval(".diagnostics-row", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  console.log("DIAG rows:");
  for (const r of rows.slice(0, 20)) console.log("  ", r);

  // Now press Space and check again
  await page.locator(".topbar button:has-text(\"DIAG\")").click();
  await page.waitForTimeout(200);
  // Use the play button instead of Space
  await page.locator(".topbar button.btn-play").click();
  await page.waitForTimeout(2000);
  await page.locator(".topbar button:has-text(\"DIAG\")").click();
  await page.waitForTimeout(500);
  const rows2 = await page.$$eval(".diagnostics-row", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  console.log("DIAG rows after play click:");
  for (const r of rows2.slice(0, 20)) console.log("  ", r);

  // Mode button check
  console.log("Mode button text after play:", await page.textContent(".topbar button.btn-mode"));

  await browser.close();
} catch (e) {
  console.error("failed:", e);
} finally {
  await server.close();
}
