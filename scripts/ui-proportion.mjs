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
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf("--url");
const URL = urlIndex >= 0 ? argv[urlIndex + 1] : "http://127.0.0.1:5173";
const SHOTS = argv.includes("--shots");
/** Add the coarse-pointer pass. See TOUCH_PASS below for why it is worth its boot. */
const TOUCH = argv.includes("--touch");

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
 * TOUCH_PASS — the coarse-pointer branch of this shell.
 *
 * Sequencer.tsx picks ROW_HEIGHT from `matchMedia("(pointer: coarse)")` and
 * 57-row-pitch.css sets `--step-h: 44px` under the same query, so on a tablet
 * every row is 46px instead of 30px. That entire branch ran in production with
 * NO gate behind it: the context here had no touch emulation, so even at
 * 390x844 the fine-pointer path answered and the report said "pitch TS 30px vs
 * CSS 30px" — correct, and about the wrong branch.
 *
 * A gate that reports a pass for a branch it never entered is worse than no
 * gate, because it closes the question. So this pass first asserts that the
 * emulated context really reports `pointer: coarse`, and exits HARNESS_ERROR
 * if it does not — a silent fall-through to the fine branch would be a green
 * light over an unmeasured surface.
 */
const TOUCH_VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 800, h: 1180 },
];
/** The value Sequencer.tsx must publish for a coarse pointer. */
const COARSE_ROW_PITCH = 46;

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


// THE PITCH CHECK. This took three attempts and each wrong one is recorded,
      // because the shape of the mistake is the reusable part.
      //
      // WHAT ROW_HEIGHT MUST BE. `cumulativeHeights` sums getItemHeight() over
      // the flat item list to produce `totalHeight` — the height of the scroll
      // spacer — and `scrollTop` is mapped through it to decide which items are
      // in view. So ROW_HEIGHT is the virtualizer's idea of how tall a row is,
      // and it has to agree with the stylesheet or the spacer is the wrong size
      // and scrolling renders the wrong rows.
      //
      // ATTEMPT 1 — "box + marginBottom". Wrong. On a coarse pointer it
      // computed 48 against ROW_HEIGHT 46 and reported a 2px drift that does
      // not exist, because the margin does not participate in layout there. It
      // passed on the fine branch only by coincidence (28 + 2 == 30).
      //
      // ATTEMPT 2 — "rendered top-to-top pitch". Also wrong, and worse: it is a
      // tautology. Mutating ROW_HEIGHT to 32 moved the rendered pitch to 32,
      // because the component lays the rows out from its own constant. A check
      // that follows the thing it checks cannot fail.
      //
      // ATTEMPT 3 — the quantity CSS alone produces: the row BOX height. Measured
      // with ROW_HEIGHT mutated 30 -> 32, the box stayed 28 on fine and 46 on
      // coarse. It is genuinely independent of the constant.
      //
      // The invariant that actually harms when violated is overlap: a row box
      // taller than the slot ROW_HEIGHT reserves means each row overlaps the
      // next by the excess, and the excess accumulates down the list. So the
      // gate asserts box <= slot, and prints both numbers so a drift is legible
      // even when it is not yet fatal.
      const assumed = Number(seq.getAttribute("data-row-height"));
      const row = rows[1] ?? rows[0];
      if (row) {
        const box = row.getBoundingClientRect().height;
        out.rowBoxHeight = Math.round(box * 100) / 100;
        out.rowMarginBottom = parseFloat(getComputedStyle(row).marginBottom) || 0;
      }
      out.rowPitchAssumed = Number.isFinite(assumed) ? assumed : null;
      out.rowBoxOverlapsSlot =
        out.rowBoxHeight != null && out.rowPitchAssumed != null && out.rowBoxHeight > out.rowPitchAssumed;
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
/**
 * Boot the studio once in a context: skip the landing page, open a project,
 * wait out the lazy studio chunk, refuse to measure a crash screen, and close
 * the first-run tour. Shared by the fine and coarse passes so the two branches
 * cannot drift into measuring different things.
 */
async function openStudio(page, label) {
  // Skip the landing page: this measures the studio shell, not onboarding.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf-onboarded", "1");
    } catch {
      /* storage blocked — the landing shows, handled below */
    }
  });

  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // WARM THE OPTIMIZER BEFORE MEASURING. Observed 2026-10-18 on this repo:
  // partway through the first load vite logged "new dependencies optimized:
  // @huggingface/transformers / optimized dependencies changed. reloading"
  // and force-reloaded the page AFTER the project was opened, so the studio
  // chrome never came up and the run died as a navigation timeout. Two earlier
  // sessions attributed that to "cold vite transform" with no log line to
  // support it; this one is in the server log. The race disappears entirely
  // under `vite preview` over dist.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "domcontentloaded" });

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
  console.log(`${label} booted once: ${resume ? "resumed last project" : "opened House template"}`);

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
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
{
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(300_000);
  page.setDefaultTimeout(300_000);

  await openStudio(page, "[fine]");

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

/**
 * The coarse-pointer pass. ONE context, resized between viewports — the same
 * reason the fine pass boots once: a fresh context per viewport is a fresh
 * cold boot of a ~180 KB AudioEngine, and three of five of those never reached
 * the studio and reported nulls that read as a collapsed sequencer.
 */
const touchReport = [];
let coarseEmulated = null;
if (TOUCH) {
  const touchContext = await browser.newContext({
    ...devices["Pixel 7"],
    viewport: { width: TOUCH_VIEWPORTS[0].w, height: TOUCH_VIEWPORTS[0].h },
  });
  const page = await touchContext.newPage();
  page.setDefaultNavigationTimeout(300_000);
  page.setDefaultTimeout(300_000);

  await openStudio(page, "[coarse]");

  // THE CLAIM UNDER TEST. If the emulated context does not actually report a
  // coarse pointer, everything below measures the fine branch and every number
  // it prints is true and irrelevant. That is HARNESS_ERROR, not a pass.
  coarseEmulated = await page.evaluate(() => ({
    coarse: window.matchMedia("(pointer: coarse)").matches,
    fine: window.matchMedia("(pointer: fine)").matches,
    anyCoarse: window.matchMedia("(any-pointer: coarse)").matches,
    touchPoints: navigator.maxTouchPoints,
  }));
  if (!coarseEmulated.coarse) {
    await touchContext.close();
    await browser.close();
    throw new Error(
      "touch context does not report (pointer: coarse) - coarse=" +
        coarseEmulated.coarse +
        " fine=" +
        coarseEmulated.fine +
        " anyCoarse=" +
        coarseEmulated.anyCoarse +
        " maxTouchPoints=" +
        coarseEmulated.touchPoints +
        ". The coarse branch would NOT be measured.",
    );
  }

  for (const vp of TOUCH_VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(900);
    const m = await measure(page);
    if (m.topbar == null) {
      await touchContext.close();
      await browser.close();
      throw new Error("studio shell absent at " + vp.w + "x" + vp.h + " (coarse) - measurement aborted");
    }
    const rows = REGIONS.map((r) => ({ label: r.label, px: m[r.key]?.h ?? null, weight: r.weight }));
    touchReport.push({ vp, m, text: table(rows, vp.w, vp.h) });
    if (SHOTS) {
      await page.screenshot({ path: resolve(outDir, "proportion-touch-" + vp.w + "x" + vp.h + ".png") });
    }
  }
  await touchContext.close();
}

await browser.close();

const overflow = report.filter((r) => r.m.docWidth > r.m.vw);
const collapsed = report.filter((r) => r.m.sequencer == null || r.m.sequencer.h < 40);
// The STYLESHEET's row box vs the COMPONENT's constant. Two independent
// sources. Deliberately NOT the rendered pitch, which is derived from that same
// constant and would make the check a tautology.
const pitchMiss = report.filter(
  (r) => r.m.rowBoxOverlapsSlot === true,
);

// The same two-source pitch check on the coarse branch, plus the branch itself:
// a coarse pointer that still publishes the fine constant means the media query
// either stopped matching or ROW_HEIGHT lost its coarse arm. Either way the
// tablet row pitch is wrong by 16px per row.
const touchOverflow = touchReport.filter((r) => r.m.docWidth > r.m.vw);
const touchCollapsed = touchReport.filter((r) => r.m.sequencer == null || r.m.sequencer.h < 40);
const touchPitchMiss = touchReport.filter(
  (r) => r.m.rowBoxOverlapsSlot === true,
);
const touchWrongConstant = touchReport.filter((r) => r.m.rowPitchAssumed !== COARSE_ROW_PITCH);

console.log("\n=== KYX studio shell - vertical budget ===\n");
for (const r of report) {
  console.log(r.text);
  console.log(
    `  doc ${r.m.docWidth}px vs viewport ${r.m.vw}px ${r.m.docWidth > r.m.vw ? "  <-- HORIZONTAL OVERFLOW" : ""}`,
  );
  console.log(
    `  sequencer rows ${r.m.sequencerRows ?? 0}, visible ${r.m.sequencerVisibleRows ?? 0}; ` +
      `row box ${r.m.rowBoxHeight ?? "?"}px (margin ${r.m.rowMarginBottom ?? 0}px) in slot TS ${r.m.rowPitchAssumed ?? "?"}px`,
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
    "FAIL: the CSS row box is TALLER than the slot Sequencer.tsx reserves - each row overlaps the next by the excess, and the excess accumulates down the list. " +
      pitchMiss
        .map((r) => `${r.vp.w}x${r.vp.h}: row box ${r.m.rowBoxHeight}px in slot TS ${r.m.rowPitchAssumed}px`)
        .join("; "),
  );
}

if (TOUCH) {
  console.log("\n=== coarse pointer (touch) - vertical budget ===\n");
  console.log(
    `  emulated: pointer:coarse=${coarseEmulated?.coarse} pointer:fine=${coarseEmulated?.fine} ` +
      `any-pointer:coarse=${coarseEmulated?.anyCoarse} maxTouchPoints=${coarseEmulated?.touchPoints}`,
  );
  console.log(`  Sequencer.tsx must publish ROW_HEIGHT ${COARSE_ROW_PITCH} on a coarse pointer\n`);
  for (const r of touchReport) {
    console.log(r.text);
    console.log(
      `  doc ${r.m.docWidth}px vs viewport ${r.m.vw}px ${r.m.docWidth > r.m.vw ? "  <-- HORIZONTAL OVERFLOW" : ""}`,
    );
    console.log(
      `  sequencer rows ${r.m.sequencerRows ?? 0}, visible ${r.m.sequencerVisibleRows ?? 0}; ` +
        `row box ${r.m.rowBoxHeight ?? "?"}px (margin ${r.m.rowMarginBottom ?? 0}px) in slot TS ${r.m.rowPitchAssumed ?? "?"}px`,
    );
    console.log("");
  }
  if (touchOverflow.length) {
    console.log(`FAIL (coarse): horizontal overflow at ${touchOverflow.map((r) => `${r.vp.w}x${r.vp.h}`).join(", ")}`);
  }
  if (touchCollapsed.length) {
    console.log(
      `FAIL (coarse): sequencer collapsed at ${touchCollapsed.map((r) => `${r.vp.w}x${r.vp.h} (${r.m.sequencer?.h ?? "missing"}px)`).join(", ")}`,
    );
  }
  if (touchPitchMiss.length) {
    console.log(
      "FAIL (coarse): the CSS row box is TALLER than the slot ROW_HEIGHT reserves. " +
        touchPitchMiss
          .map((r) => `${r.vp.w}x${r.vp.h}: row box ${r.m.rowBoxHeight}px in slot TS ${r.m.rowPitchAssumed}px`)
          .join("; "),
    );
  }
  if (touchWrongConstant.length) {
    console.log(
      `FAIL (coarse): Sequencer.tsx published ROW_HEIGHT ${touchWrongConstant.map((r) => r.m.rowPitchAssumed).join(", ")}px ` +
        `but a coarse pointer must publish ${COARSE_ROW_PITCH}px. Either the (pointer: coarse) query stopped matching ` +
        `or ROW_HEIGHT lost its coarse arm - the tablet row pitch would be wrong by ${COARSE_ROW_PITCH - (touchWrongConstant[0].m.rowPitchAssumed ?? 0)}px per row.`,
    );
  }
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
const failed =
  overflow.length ||
  collapsed.length ||
  pitchMiss.length ||
  touchOverflow.length ||
  touchCollapsed.length ||
  touchPitchMiss.length ||
  touchWrongConstant.length;
if (!failed) {
  console.log("PASS: no overflow, sequencer present at every viewport, row pitch matches the virtualizer");
  if (TOUCH) console.log("PASS (coarse): " + TOUCH_VIEWPORTS.length + " touch viewports, ROW_HEIGHT " + COARSE_ROW_PITCH + "px == CSS box");
  else console.log("NOTE: coarse-pointer branch NOT measured - pass --touch to cover it");
}
process.exit(failed ? EXIT_GATE_FAILED : 0);
