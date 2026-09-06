/**
 * PWA update-flow smoke (release roadmap Fáza 3).
 *
 * Simulates a real deployment cycle end to end:
 *   1. build v1 → serve → load page → service worker activates
 *   2. rebuild (v2 ships a new public file → new sw.js revision)
 *   3. reload → new worker installs and WAITS (prompt mode)
 *   4. the "New version ready" banner appears
 *   5. click RELOAD → fresh page boots without errors
 *
 * The static server reads from DISK on every request (vite preview's sirv
 * caches the file map at startup, so a rebuild would be invisible to it —
 * the exact deployment scenario this smoke exercises). sw.js + html are
 * served no-cache like production CDNs configure them.
 *
 * Usage: node scripts/pwa-update-smoke.mjs
 */
import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const PORT = 5232;
const distDir = join(root, "dist");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = join(distDir, urlPath === "/" ? "index.html" : urlPath.replace(/^\//, ""));
  try {
    statSync(file);
  } catch {
    file = join(distDir, "index.html"); // SPA fallback
  }
  const noCache = file.endsWith("sw.js") || file.endsWith(".html");
  if (process.env.SMOKE_DEBUG && urlPath.includes("sw.js")) console.log("REQ", urlPath, new Date().toISOString().slice(11, 19));
  readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": noCache ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

console.log("building v1…");
execSync("npx vite build", { stdio: "pipe" });

const browser = await chromium.launch();
const context = await browser.newContext();
const errors = [];

const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`v1: ${String(e)}`));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
// First visit: the worker installs and activates (no prior worker).
let firstState = "none";
for (let i = 0; i < 40; i++) {
  firstState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return "none";
    if (reg.waiting) return "waiting";
    return reg.active ? "active" : "installing";
  });
  if (firstState === "active") break;
  await page.waitForTimeout(250);
}
if (firstState !== "active") throw new Error(`v1 worker never activated: ${firstState}`);
console.log("v1 worker: active");
await page.waitForTimeout(500);

console.log("building v2…");
// A real deployment ships CHANGED sources — a deterministic rebuild with
// unchanged input produces an identical sw.js and the browser correctly
// detects no update. Ship a new public file (it enters the precache glob).
writeFileSync(join(root, "public", "pwa-update-smoke-marker.js"), "// pwa update smoke marker");
execSync("npx vite build", { stdio: "pipe" });

// Reload: the navigation triggers the sw.js byte-diff check → new worker
// installs → prompt mode parks it → the banner must appear.
await page.reload({ waitUntil: "networkidle" });
// Force an explicit update check too — navigations normally trigger it.
await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  await reg?.update().catch(() => {});
});
let banner = false;
let lastStates = "";
for (let i = 0; i < 30; i++) {
  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const has = (key) => (reg?.[key] ? "yes" : "no");
    return `active:${has("active")} waiting:${has("waiting")} installing:${has("installing")} banner:${!!document.getElementById("pf-update-banner")}`;
  });
  lastStates = state;
  if (state.includes("banner:true")) {
    banner = true;
    break;
  }
  await page.waitForTimeout(500);
}
console.log("update banner:", banner ? "APPEARED" : "MISSING", "| last state:", lastStates);

let reloadOk = false;
if (banner) {
  await page.locator("#pf-update-banner button", { hasText: "RELOAD" }).click();
  await page.waitForLoadState("networkidle");
  const text = await page.evaluate(() => document.body.innerText.slice(0, 120));
  reloadOk = text.length > 0;
  console.log("post-reload page:", text.replace(/\n/g, " | ").slice(0, 100));
}

await browser.close();
server.close();

// Remove the marker and rebuild so dist matches the real app again.
rmSync(join(root, "public", "pwa-update-smoke-marker.js"), { force: true });
execSync("npx vite build", { stdio: "pipe" });

const failed = !banner || !reloadOk || errors.length > 0;
console.log("errors:", errors.length ? errors : "none");
console.log(failed ? "SMOKE FAILED" : "UPDATE FLOW OK");
process.exit(failed ? 1 : 0);
