/**
 * Startup profile (release roadmap 2.4). Measures the eager boot costs in a
 * REAL browser (headless Chromium + vite dev):
 *
 *   1. generateFactoryBank()  — the dominant createCoreServices() cost
 *   2. createProjectFromTemplate + normalizeProject — per-open doc cost
 *   3. end-to-end studio entry — click → project browser mounted
 *
 * Usage: node scripts/startup-profile.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5231;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();

// 0) Navigate first — module specifiers need the dev-server base URL.
const tNav = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
const navMs = Date.now() - tNav;

// 1) Module-level costs, measured inside the real browser runtime.
const moduleCosts = await page.evaluate(async () => {
  const factory = await import("/src/sample-library/factory.ts");
  const schema = await import("/src/project-model/schema.ts");
  const templates = await import("/src/project-model/templates.ts");

  const t0 = performance.now();
  const bank = await factory.generateFactoryBank();
  const bankMs_ = performance.now() - t0;

  const t1 = performance.now();
  const doc = templates.createProjectFromTemplate("house");
  const templateMs = performance.now() - t1;

  const t2 = performance.now();
  schema.normalizeProject(doc);
  const normalizeMs = performance.now() - t2;

  return {
    bankMs: +bankMs_.toFixed(1),
    bankAssets: bank ? Object.keys(bank).length : -1,
    templateMs: +templateMs.toFixed(2),
    normalizeMs: +normalizeMs.toFixed(2),
  };
});
console.log("generateFactoryBank:", moduleCosts.bankMs, "ms");
console.log("createProjectFromTemplate:", moduleCosts.templateMs, "ms");
console.log("normalizeProject:", moduleCosts.normalizeMs, "ms");

// 2) End-to-end studio entry: landing → OPEN THE STUDIO → project browser.
const tClick = Date.now();
await page.locator('button:has-text("OPEN THE STUDIO")').first().click();
await page.locator(".project-browser").waitFor({ timeout: 30000 });
const studioMs = Date.now() - tClick;

console.log("initial navigation (dev, incl. module graph):", navMs, "ms");
console.log("OPEN THE STUDIO → project browser mounted:", studioMs, "ms");

await browser.close();
await server.close();
process.exit(0);
