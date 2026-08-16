// Investigation: PATTERN/SONG mode button + playback
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5201;

const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();

try {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
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

  // Expose services for direct inspection
  await page.evaluate(() => {
    // hook into React DevTools - we can't access Services easily without source modification
    // Instead, read mode from button text
  });

  // Test 1: PATTERN/SONG button
  console.log("Initial button text:", await page.textContent(".topbar button.btn-mode"));
  await page.click(".topbar button.btn-mode");
  await page.waitForTimeout(300);
  console.log("After 1st click:", await page.textContent(".topbar button.btn-mode"));
  await page.click(".topbar button.btn-mode");
  await page.waitForTimeout(300);
  console.log("After 2nd click:", await page.textContent(".topbar button.btn-mode"));

  // Test 2: play via Space
  await page.locator(".topbar button:has-text(\"DIAG\")").click();
  await page.waitForTimeout(500);
  const diagIdle = await page.textContent(".diagnostics");
  console.log("DIAG idle (transportPlaying):", /transportPlaying\s+(\w+)/.exec(diagIdle)?.[1]);
  console.log("DIAG idle (scheduledEvents):", /scheduledEvents\s+(\d+)/.exec(diagIdle)?.[1]);

  // close diag
  await page.locator(".topbar button:has-text(\"DIAG\")").click();
  await page.waitForTimeout(200);

  // try focus body and press space
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await page.waitForTimeout(2500);
  await page.locator(".topbar button:has-text(\"DIAG\")").click();
  await page.waitForTimeout(500);
  const diagPlaying = await page.textContent(".diagnostics");
  console.log("DIAG playing (transportPlaying):", /transportPlaying\s+(\w+)/.exec(diagPlaying)?.[1]);
  console.log("DIAG playing (scheduledEvents):", /scheduledEvents\s+(\d+)/.exec(diagPlaying)?.[1]);
  console.log("DIAG playing (schedulerRunning):", /schedulerRunning\s+(\w+)/.exec(diagPlaying)?.[1]);
  console.log("DIAG playing (transportTick):", /transportTick\s+(\d+)/.exec(diagPlaying)?.[1]);

  await browser.close();
} catch (e) {
  console.error("investigation failed:", e);
} finally {
  await server.close();
}
