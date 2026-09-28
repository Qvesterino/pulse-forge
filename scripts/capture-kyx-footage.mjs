/**
 * Capture real KYX screen recordings for the Audiotool "Let's Build!" demo.
 *
 * These are genuine recordings of the running product, driven through
 * Playwright against `vite preview` of the production build. Nothing here
 * fabricates UI: every shot is the real app doing the real thing, and the
 * intent phrases typed are commands the Intent Engine actually supports.
 *
 * Usage:
 *   npx vite preview --port 4173 --strictPort     # in D:\pulse-forge
 *   node scripts/capture-kyx-footage.mjs
 *
 * Output: remotion/audiotool-demo/assets/captures/*.webm
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync, readdirSync, renameSync, statSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../remotion/audiotool-demo/assets/captures");
const URL_ARG = process.argv.indexOf("--url");
const BASE = URL_ARG !== -1 ? process.argv[URL_ARG + 1] : "http://localhost:4173";

if (existsSync(OUT)) {
  for (const f of readdirSync(OUT)) rmSync(resolve(OUT, f), { force: true });
} else {
  mkdirSync(OUT, { recursive: true });
}

const log = (...m) => console.log("[capture]", ...m);

/** The intent phrases below are real KYX commands — see src/intent/route.ts. */
const INTENT_PUNCH = "make the drums hit harder and open the beat up";
const INTENT_MIX = "louder drums";

/** The studio is a separate lazy route — `/studio` boots the real DAW. */
async function openStudio(page) {
  await page.goto(new URL("/studio", BASE).href, { waitUntil: "domcontentloaded" });
  // The studio route is the largest bundle; give it real time to mount.
  await page.waitForTimeout(9000);
  // It opens on a project browser — take the first project so the DAW shows.
  const open = page
    .getByRole("button", { name: /^(open|continue|resume|load|new|blank|empty|house|beat|template)/i })
    .first();
  if (await open.count()) {
    try {
      await open.click({ timeout: 4000 });
      await page.waitForTimeout(9000);
    } catch {
      /* the studio may already be open */
    }
  }
  await page.waitForTimeout(4000);
}

async function typeIntent(page, text) {
  const input = page.locator('input[placeholder*="Describe your beat"]').first();
  if (await input.count()) {
    await input.click();
    await page.waitForTimeout(600);
    await page.keyboard.type(text, { delay: 48 });
    return true;
  }
  return false;
}

async function forge(page) {
  const btn = page.getByRole("button", { name: /forge it/i }).first();
  if (await btn.count()) {
    await btn.click();
    return true;
  }
  return false;
}

async function capture(name, fn) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4000);
    await fn(page);
  } catch (err) {
    log(`  !! ${name}: ${err.message}`);
  }

  await page.waitForTimeout(1500);
  await context.close();

  const files = readdirSync(OUT).filter((f) => f.endsWith(".webm"));
  const newest = files
    .map((f) => ({ f, t: statSync(resolve(OUT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (newest) {
    try {
      renameSync(resolve(OUT, newest.f), resolve(OUT, `${name}.webm`));
      log(`  ok  ${name}.webm`);
    } catch {
      log(`  !! rename failed for ${name}`);
    }
  }
  if (errors.length) log(`  !! ${name} page errors: ${errors.slice(0, 2).join(" | ")}`);
}

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

log(`capturing from ${BASE}`);

/** 01 — the product surface. Hero, then the real studio opening. */
await capture("01-product-overview", async (page) => {
  await page.waitForTimeout(2500);
  for (const x of [0.2, 0.45, 0.7]) {
    await page.mouse.move(700 + x * 500, 560);
    await page.waitForTimeout(1300);
  }
  await openStudio(page);
  await page.waitForTimeout(4000);
});

/** 02 — THE HERO. A real intent, typed and forged. */
await capture("02-intent-engine", async (page) => {
  const typed = await typeIntent(page, INTENT_PUNCH);
  log(`  intent typed: ${typed}`);
  await page.waitForTimeout(1000);
  const forged = await forge(page);
  log(`  forged: ${forged}`);
  await page.waitForTimeout(9000);
});

/** 03 — direct manipulation. The studio is still a normal instrument. */
await capture("03-manual-editing", async (page) => {
  await openStudio(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(3500);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  // Real clicks on the arrangement / mixer area.
  for (const [x, y] of [
    [820, 700],
    [1180, 700],
    [1500, 760],
  ]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);
});

/** 04 — the beat before the production intent is applied. */
await capture("04-before", async (page) => {
  await openStudio(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(8000);
});

/** 05 — the same beat after "make the drums hit harder". */
await capture("05-after", async (page) => {
  await openStudio(page);
  const typed = await typeIntent(page, INTENT_PUNCH);
  if (typed) {
    await forge(page);
    await page.waitForTimeout(5000);
  }
  await page.keyboard.press("Space");
  await page.waitForTimeout(8000);
});

/** 07 — final playback of the result. */
await capture("07-final-playback", async (page) => {
  await openStudio(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(11_000);
});

await browser.close();
log("done ->", OUT);
