/**
 * Re-capture one KYX clip by name into the Remotion public/ directory.
 * Split out from capture-kyx-footage.mjs so a single missing clip can be
 * regenerated without re-running the whole set.
 *
 * Usage: node scripts/recapture-kyx-clip.mjs 01-product-overview
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../QVESTER_LANDING_PAGE/remotion/audiotool-demo/public");
const BASE = "http://localhost:4173";
const name = process.argv[2];

if (!name) {
  console.error("Usage: node scripts/recapture-kyx-clip.mjs <clipName>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

async function openStudio(page) {
  await page.goto(new URL("/studio", BASE).href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000);
  const open = page
    .getByRole("button", { name: /^(open|continue|resume|load|new|blank|empty|house|beat|template)/i })
    .first();
  if (await open.count()) {
    try {
      await open.click({ timeout: 4000 });
      await page.waitForTimeout(9000);
    } catch {
      /* already open */
    }
  }
  await page.waitForTimeout(4000);
}

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForTimeout(4000);

if (name === "01-product-overview") {
  await page.waitForTimeout(2500);
  for (const x of [0.2, 0.45, 0.7]) {
    await page.mouse.move(700 + x * 500, 560);
    await page.waitForTimeout(1300);
  }
  await openStudio(page);
  await page.waitForTimeout(4000);
} else {
  console.error(`No recipe for "${name}" — add one, or re-run capture-kyx-footage.mjs`);
  await browser.close();
  process.exit(2);
}

await page.waitForTimeout(1500);
await context.close();
await browser.close();

const files = readdirSync(OUT).filter((f) => f.endsWith(".webm"));
const newest = files
  .map((f) => ({ f, t: statSync(resolve(OUT, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (newest) {
  const target = resolve(OUT, `${name}.webm`);
  renameSync(resolve(OUT, newest.f), target);
  console.log("wrote", target);
}
