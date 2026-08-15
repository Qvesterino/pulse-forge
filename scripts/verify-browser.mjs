import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5199;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

let exitCode = 0;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

  const results = await page.evaluate(async () => {
    const mod = await import("/src/browser-checks.ts");
    return mod.runChecks();
  });

  let failed = 0;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failed++;
    console.log(`[${status}] ${r.name}${r.message && r.message !== "ok" ? ` — ${r.message}` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
  if (consoleErrors.length > 0) {
    console.log("console errors:", consoleErrors.slice(0, 5));
    failed++;
  }
  exitCode = failed > 0 ? 1 : 0;
} catch (error) {
  console.error("browser verification failed:", error);
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  process.exit(exitCode);
}
