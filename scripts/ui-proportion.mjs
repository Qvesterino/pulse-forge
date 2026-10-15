#!/usr/bin/env node
/**
 * ui-proportion.mjs — measure the studio shell's vertical budget in a live browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * The premium-UI work started from eyeballing PNGs, and eyeballing produced a
 * wrong number: the step sequencer — the primary instrument of a step-based
 * DAW — was measured at ~70px of a 1440x900 viewport (7.8%) while the dock
 * panel took 495px (55%). At 800x900 the sequencer measured ZERO visible px
 * because it was squeezed between the pattern toolbar and the dock.
 *
 * A screenshot cannot tell you WHY a region got small, and it cannot be
 * diffed numerically between two commits. This does: it opens the real app,
 * reads getBoundingClientRect() on the chrome regions, and prints the budget
 * as a table. It is the measuring instrument for the proportion waves — run it
 * before and after a change and compare the two tables.
 *
 * USAGE
 *   node scripts/ui-proportion.mjs [--url http://127.0.0.1:5173] [--shots]
 *
 *   --url    dev/preview server to measure (default 127.0.0.1:5173)
 *   --shots  also write PNGs to output/playwright/proportion-<w>x<h>.png
 *
 * Requires a dev or preview server already running; this script never starts
 * one (vite's first cold transform of AudioEngine.ts takes minutes).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf("--url");
const URL = urlIndex >= 0 ? argv[urlIndex + 1] : "http://127.0.0.1:5173";
const SHOTS = argv.includes("--shots");

/** Cold-transform budget for the lazily-imported studio chunk on vite dev. */
const STUDIO_WAIT_MS = 480_000;

/** Viewports from the QA matrix in docs/PULSE-FORGE-PREMIUM-UI-PLAN.md. */
const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
  { w: 800, h: 900 },
  { w: 390, h: 844 },
];

/**
 * Regions in top-to-bottom order. `weight` is what this slice is trying to
 * move: the sequencer is the product's primary instrument, so its share of
 * the viewport is the number that has to go up.
 */
const REGIONS = [
  { key: "topbar", label: "TopBar", selector: ".topbar" },
  { key: "rack", label: "Pad rack", selector: ".rack" },
  { key: "patternbar", label: "Pattern toolbar", selector: ".pattern-bar" },
  { key: "sequencer", label: "SEQUENCER", selector: ".sequencer", weight: true },
  { key: "dockchrome", label: "Dock tabs", selector: ".dock-tabs" },
  { key: "dock", label: "Dock panel", selector: ".bottom-panels .dock-slot, .dock-slot" },
  { key: "statusbar", label: "Statusbar", selector: ".statusbar" },
];

/** Measured in the page so the numbers come from the real layout engine. */
async function measure(page) {
  return page.evaluate((regions) => {
    const out = { docWidth: document.documentElement.scrollWidth, vw: window.innerWidth };
    for (const r of regions) {
      const el = document.querySelector(r.selector);
      if (!el) {
        out[r.key] = null;
        continue;
      }
      const box = el.getBoundingClientRect();
      out[r.key] = { h: Math.round(box.height), w: Math.round(box.width), top: Math.round(box.top) };
    }
    // The sequencer's CONTENT height, not its box: a windowing/virtualisation
    // bug can show a correct-looking box whose rows are scrolled out of view.
    const seq = document.querySelector(".sequencer");
    if (seq) {
      const rows = seq.querySelectorAll(".sequencer-row");
      out.sequencerRows = rows.length;
      let visible = 0;
      const seqBox = seq.getBoundingClientRect();
      for (const row of rows) {
        const rb = row.getBoundingClientRect();
        if (rb.bottom > seqBox.top && rb.top < seqBox.bottom) visible += 1;
      }
      out.sequencerVisibleRows = visible;
    }
    return out;
  }, REGIONS);
}

function table(rows, vw, vh) {
  const lines = [];
  lines.push(`viewport ${vw}x${vh}`);
  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  lines.push(`  ${pad("region", 18)}${rpad("px", 6)}${rpad("%vh", 7)}`);
  for (const r of rows) {
    const px = r.px;
    lines.push(`  ${pad(r.label + (r.weight ? " *" : ""), 18)}${rpad(px, 6)}${rpad(px == null ? "-" : ((px / vh) * 100).toFixed(1) + "%", 7)}`);
  }
  return lines.join("\n");
}

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const outDir = resolve("output/playwright");
if (SHOTS) mkdirSync(outDir, { recursive: true });

const report = [];
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  const page = await context.newPage();

  // Skip the landing page: this measures the studio shell, not onboarding.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
    } catch {
      /* storage blocked — the landing shows, handled below */
    }
  });

  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // Fresh browser profiles have no saved project, so the project browser is
  // showing templates. `.pb-template-start` is the House template, pinned by
  // ProjectBrowser.tsx as the first-run entry.
  const startCard = page.locator("button.pb-template-start").first();
  const continueCard = page.locator("button.pb-continue-card").first();
  const ready = startCard.or(continueCard).first();
  await ready.waitFor({ state: "visible", timeout: 120_000 });
  if (await continueCard.isVisible().catch(() => false)) {
    await continueCard.click();
  } else {
    await startCard.click();
  }

  // `main.tsx` lazy-imports the studio (`./ui/App`) only once a project is
  // opened, and that chunk reaches 70+ panels. On a cold vite dev server the
  // on-demand transform of that graph takes MINUTES on the first request and
  // every later request is served from the transform cache — so the first run
  // of this script is slow and every run after it is fast. Waiting less than
  // this reports a cold transform as a product bug.
  await page
    .locator(".topbar, .crash-screen, .boot-error")
    .first()
    .waitFor({ state: "visible", timeout: STUDIO_WAIT_MS });
  await page.waitForTimeout(1200);

  // A boot that settled on an error screen is a real result, not a timeout to
  // hide behind — surface it instead of measuring an empty document.
  const crashed = await page.locator(".crash-screen, .boot-error").first();
  if ((await crashed.count()) > 0) {
    const text = (await crashed.innerText()).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`studio boot did not settle at ${vp.w}x${vp.h}: ${text}`);
  }

  const m = await measure(page);
  const rows = REGIONS.map((r) => ({ label: r.label, px: m[r.key]?.h ?? null, weight: r.weight }));
  report.push({ vp, m, text: table(rows, vp.w, vp.h) });

  if (SHOTS) {
    await page.screenshot({ path: resolve(outDir, `proportion-${vp.w}x${vp.h}.png`) });
  }
  await context.close();
}

await browser.close();

const overflow = report.filter((r) => r.m.docWidth > r.m.vw);
const collapsed = report.filter((r) => r.m.sequencer == null || r.m.sequencer.h < 40);

console.log("\n=== KYX studio shell — vertical budget ===\n");
for (const r of report) {
  console.log(r.text);
  console.log(
    `  doc ${r.m.docWidth}px vs viewport ${r.m.vw}px ${r.m.docWidth > r.m.vw ? "  <-- HORIZONTAL OVERFLOW" : ""}`,
  );
  console.log(`  sequencer rows ${r.m.sequencerRows ?? 0}, visible ${r.m.sequencerVisibleRows ?? 0}`);
  console.log("");
}
if (overflow.length) {
  console.log(`FAIL: horizontal overflow at ${overflow.map((r) => `${r.vp.w}x${r.vp.h}`).join(", ")}`);
}
if (collapsed.length) {
  console.log(
    `FAIL: sequencer collapsed at ${collapsed.map((r) => `${r.vp.w}x${r.vp.h} (${r.m.sequencer?.h ?? "missing"}px)`).join(", ")}`,
  );
}
if (!overflow.length && !collapsed.length) console.log("PASS: no overflow, sequencer present at every viewport");
process.exit(overflow.length || collapsed.length ? 1 : 0);