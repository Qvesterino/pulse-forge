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

      // THE PITCH CHECK. Compares Sequencer.tsx ROW_HEIGHT against the row box
      // the STYLESHEET lays out — two INDEPENDENT sources, joined through the
      // `data-row-height` attribute the component publishes.
      //
      // It deliberately does NOT compare the rendered top-to-top pitch: rows are
      // absolutely positioned from `cumulativeHeights`, so the rendered pitch
      // equals ROW_HEIGHT by construction and such a check is a tautology. The
      // first version of this gate did exactly that and PASSED while
      // ROW_HEIGHT was deliberately mutated — a check against your own output is
      // not a check.
      const assumed = Number(seq.getAttribute("data-row-height"));
      const row = rows[1] ?? rows[0];
      if (row) {
        const style = getComputedStyle(row);
        const box = row.getBoundingClientRect().height;
        const margin = parseFloat(style.marginBottom) || 0;
        out.rowPitchFromCss = Math.round((box + margin) * 100) / 100;
      }
      out.rowPitchAssumed = Number.isFinite(assumed) ? assumed : null;
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
    lines.push(
      `  ${pad(r.label + (r.weight ? " *" : ""), 18)}${rpad(px, 6)}${rpad(px == null ? "-" : ((px / vh) * 100).toFixed(1) + "%", 7)}`,
    );
  }
  return lines.join("\n");
}

const EXIT_GATE_FAILED = 1;
const EXIT_HARNESS_ERROR = 2;

// A navigation timeout also exits non-zero, so without a separate code it is
// indistinguishable from a caught defect: twice this script reported exit 1
// having evaluated nothing, because the cold dev server timed out the page load.
process.on("uncaughtException", (error) => {
  console.error(`\nHARNESS_ERROR ${error?.message ?? error}`);
  console.error("The measurement did not complete. NOT a gate result - nothing was checked.");
  process.exit(EXIT_HARNESS_ERROR);
});

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const outDir = resolve("output/playwright");
if (SHOTS) mkdirSync(outDir, { recursive: true });

const report = [];
// ONE boot, then resize between viewports.
//
// The first version created a fresh context per viewport, which meant five
// full boots of a ~180 KB AudioEngine against a dev server that parallel agent
// sessions were also hammering. Three of the five never reached the studio at
// all and reported `null` for every region — a measurement failure that looks
// exactly like a collapsed sequencer. Booting once and driving the viewport
// removes that failure mode, runs ~5x faster, and measures the same thing:
// every breakpoint in this shell is CSS (media + container queries), all of
// which respond to a resize.
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
{
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(300_000);
  page.setDefaultTimeout(300_000);

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
  //
  // A stored project from an earlier run wins when it exists, so the continue
  // card is preferred. Do NOT collapse this into `a.or(b)` for the click: the
  // union locator also decides which element was clicked, and with no
  // continue card present the first version of this script waited out its
  // full budget on a studio that was actually up in five seconds.
  const continueCard = page.locator("button.pb-continue-card");
  const templateCard = page.locator("button.pb-template-start");
  await continueCard.or(templateCard).first().waitFor({ state: "visible", timeout: 60_000 });
  const resume = (await continueCard.count()) > 0 && (await continueCard.isVisible());
  await (resume ? continueCard : templateCard).first().click();
  console.log(`booted once: ${resume ? "resumed last project" : "opened House template"}`);

  // `main.tsx` lazy-imports the studio (`./ui/App`) only once a project is
  // opened. The budget stays generous for a cold vite dev server.
  await page
    .locator(".topbar, .crash-screen, .boot-error")
    .first()
    .waitFor({ state: "visible", timeout: STUDIO_WAIT_MS });
  await page.waitForTimeout(1200);

  // A boot that settled on an error screen is a real result, not a timeout to
  // hide behind — surface it instead of measuring an empty document.
  const crashed = page.locator(".crash-screen, .boot-error").first();
  if ((await crashed.count()) > 0) {
    const text = (await crashed.innerText()).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`studio boot did not settle: ${text}`);
  }

  // The first-run tour overlays the shell and would shift every measurement.
  // It is a dismissible overlay, not part of the layout under test, so close
  // it before measuring — the QA matrix in the plan doc requires the same.
  const skipTour = page.locator("button:has-text('SKIP')").first();
  if ((await skipTour.count()) > 0 && (await skipTour.isVisible().catch(() => false))) {
    await skipTour.click().catch(() => {});
    await page.waitForTimeout(400);
  }

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    // Let media/container queries settle before reading boxes.
    await page.waitForTimeout(900);

    const m = await measure(page);
    if (m.topbar == null) {
      throw new Error(
        `studio shell absent at ${vp.w}x${vp.h} — measurement aborted, not reported as a collapsed sequencer`,
      );
    }
    const rows = REGIONS.map((r) => ({ label: r.label, px: m[r.key]?.h ?? null, weight: r.weight }));
    report.push({ vp, m, text: table(rows, vp.w, vp.h) });

    if (SHOTS) {
      await page.screenshot({ path: resolve(outDir, `proportion-${vp.w}x${vp.h}.png`) });
    }
  }
}
await context.close();
await browser.close();

const overflow = report.filter((r) => r.m.docWidth > r.m.vw);
const collapsed = report.filter((r) => r.m.sequencer == null || r.m.sequencer.h < 40);
// The STYLESHEET's row box vs the COMPONENT's constant. Two independent
// sources. Deliberately NOT the rendered pitch, which is derived from that same
// constant and would make the check a tautology.
const pitchMiss = report.filter(
  (r) => r.m.rowPitchFromCss != null && r.m.rowPitchAssumed != null && r.m.rowPitchFromCss !== r.m.rowPitchAssumed,
);

console.log("\n=== KYX studio shell - vertical budget ===\n");
for (const r of report) {
  console.log(r.text);
  console.log(
    `  doc ${r.m.docWidth}px vs viewport ${r.m.vw}px ${r.m.docWidth > r.m.vw ? "  <-- HORIZONTAL OVERFLOW" : ""}`,
  );
  console.log(
    `  sequencer rows ${r.m.sequencerRows ?? 0}, visible ${r.m.sequencerVisibleRows ?? 0}; ` +
      `pitch TS ${r.m.rowPitchAssumed ?? "?"}px vs CSS box+gap ${r.m.rowPitchFromCss ?? "?"}px`,
  );
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
if (pitchMiss.length) {
  console.log(
    "FAIL: Sequencer.tsx ROW_HEIGHT disagrees with the CSS row box - each row would overlap or gap " +
      "its neighbour by the difference, accumulating down the list. " +
      pitchMiss
        .map((r) => `${r.vp.w}x${r.vp.h}: TS ${r.m.rowPitchAssumed}px vs CSS ${r.m.rowPitchFromCss}px`)
        .join("; "),
  );
}

/**
 * Exit codes are load-bearing. 0 = the gate ran and passed. 1 = the gate ran
 * and FAILED. 2 = HARNESS_ERROR - the measurement never completed.
 *
 * A navigation timeout also exits non-zero, so without a separate code it is
 * indistinguishable from "the gate caught a defect": the first falsification
 * of the pitch check reported exit 1 having never evaluated the pitch at all.
 * A gate that cannot tell "I checked and it is wrong" from "I never checked"
 * reports the same score for both, and the second reading is worthless.
 */
const failed = overflow.length || collapsed.length || pitchMiss.length;
if (!failed) {
  console.log("PASS: no overflow, sequencer present at every viewport, row pitch matches the virtualizer");
}
process.exit(failed ? EXIT_GATE_FAILED : 0);
