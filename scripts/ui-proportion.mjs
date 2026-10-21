/**
 * ui-proportion.mjs — the studio shell's vertical budget, measured across a
 * MATRIX: five viewports × three media branches.
 *
 * WHAT THIS MEASURES
 * ------------------
 * A screenshot cannot tell you WHY a region got small, and it cannot be
 * diffed numerically between two commits. This does: it opens the real app,
 * reads getBoundingClientRect() on the chrome regions, and prints the budget
 * as a table. It is the measuring instrument for the proportion waves — run it
 * before and after a change and compare the two tables.
 *
 * THE MATRIX (5 × 3 = 15 measurements)
 * ------------------------------------
 * The plan asks for "5 viewports × 3 pointer types = 15 measurements on
 * release" (docs/STUDIO-OPTIMIZATION-PLAN.md §5.1). The third column is NOT
 * `pointer: none`, and that is a measured fact, not a preference:
 *
 *   MEASURED 2026-10-21 in this Chromium (Playwright 1.62.1):
 *     pointer: fine    yes — a plain desktop context
 *     pointer: coarse  yes — hasTouch, or any mobile device descriptor
 *     pointer: none    NO  — `emulateMedia` has no pointer option, and no
 *                              context configuration produces it
 *
 * A matrix column that the harness cannot enter is not a measurement, it is a
 * line of code that always passes. So the third column is the OTHER real
 * media branch of this shell: `prefers-reduced-motion: reduce`. It is not a
 * nicety — 14 stylesheets carry a reduced-motion block, including
 * `50-motion-accessibility.css`, which zeroes `animation` and `transition` on
 * every element. NO gate covered it before this matrix.
 *
 *   mouse          pointer: fine                          desktop branch
 *   touch          pointer: coarse                        tablet branch (46px rows)
 *   reduced motion prefers-reduced-motion: reduce         accessibility branch
 *
 * Each column asserts ITS OWN claim before it measures anything: the context
 * must really report that media state, or the run is HARNESS_ERROR. A gate
 * that reports a pass for a branch it never entered is worse than no gate,
 * because it closes the question.
 *
 * USAGE
 *   node scripts/ui-proportion.mjs [--url http://127.0.0.1:5173] [--shots]
 *                                  [--only mouse|touch|reduced-motion]
 *
 *   --url    dev/preview server to measure (default 127.0.0.1:5173)
 *   --shots  also write PNGs to output/playwright/proportion-<w>x<h>.png
 *   --only   measure a single column (fast local iteration)
 *
 * Requires a dev or preview server already running; this script never starts
 * one (vite's first cold transform of AudioEngine.ts takes minutes).
 */
import { chromium } from "playwright";
import { bootStudio } from "./lib/studio-boot.mjs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf("--url");
const URL = urlIndex >= 0 ? argv[urlIndex + 1] : "http://127.0.0.1:5173";
const SHOTS = argv.includes("--shots");
const onlyIndex = argv.indexOf("--only");
const ONLY = onlyIndex >= 0 ? argv[onlyIndex + 1] : null;

/** Viewports from the QA matrix in docs/PULSE-FORGE-PREMIUM-UI-PLAN.md. */
const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
  { w: 800, h: 900 },
  { w: 390, h: 844 },
];

/**
 * THE THREE COLUMNS.
 *
 * `expect` is the claim under test: the context MUST report exactly these
 * media values, or the run ends in HARNESS_ERROR. `expectRowPitch` is the
 * value Sequencer.tsx must publish for that branch — a coarse pointer gets
 * the 46px touch pitch, everything else gets 30px.
 *
 * `hasTouch: true` WITHOUT `isMobile: true` is deliberate: `isMobile` turns
 * on the mobile viewport meta handling, which is a different device class.
 * A touch laptop at 1440×900 is a coarse pointer on a desktop viewport, and
 * that is the case the shell's own media queries have to survive.
 */
const MEDIA_CONFIGS = [
  {
    key: "mouse",
    label: "mouse",
    mediaLabel: "pointer: fine",
    expect: { pointerFine: true, pointerCoarse: false, reducedMotion: false },
    expectRowPitch: 30,
    context: (vp) => ({ viewport: { width: vp.w, height: vp.h } }),
    async prepare() {},
  },
  {
    key: "touch",
    label: "touch",
    mediaLabel: "pointer: coarse",
    expect: { pointerFine: false, pointerCoarse: true, reducedMotion: false },
    expectRowPitch: 46,
    context: (vp) => ({ viewport: { width: vp.w, height: vp.h }, hasTouch: true }),
    async prepare() {},
  },
  {
    key: "reduced-motion",
    label: "reduced motion",
    mediaLabel: "prefers-reduced-motion: reduce",
    expect: { pointerFine: true, pointerCoarse: false, reducedMotion: true },
    expectRowPitch: 30,
    context: (vp) => ({ viewport: { width: vp.w, height: vp.h } }),
    async prepare(page) {
      await page.emulateMedia({ reducedMotion: "reduce" });
    },
  },
];

const CONFIGS = ONLY ? MEDIA_CONFIGS.filter((c) => c.key === ONLY) : MEDIA_CONFIGS;
if (CONFIGS.length === 0) {
  console.error(`HARNESS_ERROR: unknown --only "${ONLY}". Use one of: ${MEDIA_CONFIGS.map((c) => c.key).join(", ")}`);
  process.exit(2);
}

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

    // THE MOTION CHECK. `50-motion-accessibility.css` zeroes `animation` and
    // `transition` on every element under `prefers-reduced-motion: reduce`.
    // This samples the elements the shell actually animates and reports the
    // LONGEST transition duration among them.
    //
    // Why sample a SET and not one element: the sheet is `* { transition: none
    // !important }`, so any element answers 0s in the reduced branch. The
    // interesting number is the one on the OTHER side of that switch — if the
    // shell stopped animating altogether, "0s" would pass everywhere and mean
    // nothing. The mouse column therefore asserts the shell DOES animate
    // (max > 0), which makes the reduced column's 0s a real observation.
    const animated = document.querySelectorAll(
      ".btn, .btn-small, .dock-tab, .step, .pattern-chip, .transport-cluster button, .topbar button",
    );
    let max = 0;
    let sampled = 0;
    for (const el of Array.from(animated).slice(0, 60)) {
      sampled += 1;
      const value = getComputedStyle(el).transitionDuration;
      for (const part of String(value).split(",")) {
        const seconds = parseFloat(part);
        if (Number.isFinite(seconds) && seconds > max) max = seconds;
      }
    }
    out.maxTransitionSeconds = max;
    out.animatedElementsSampled = sampled;

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
// ONE boot PER COLUMN, then resize between viewports.
//
// The first version created a fresh context per viewport, which meant five
// full boots of a ~180 KB AudioEngine against a dev server that parallel agent
// sessions were also hammering. Three of the five never reached the studio at
// all and reported `null` for every region — a measurement failure that looks
// exactly like a collapsed sequencer. Booting once per column and driving
// the viewport removes that failure mode, runs ~5x faster, and measures the
// same thing: every breakpoint in this shell is CSS (media + container
// queries), all of which respond to a resize.
/**
 * Boot the studio once. The implementation lives in scripts/lib/studio-boot.mjs
 * because FOUR gates each carried their own copy of it, and one app-side class
 * rename (`pb-template-start` -> `pb-template`, commit 8d11f16b) broke all four
 * at once. This file keeps only the label.
 */
async function openStudio(page, label) {
  await bootStudio(page, URL, { label });
}

/** Read the media state the context is actually in. */
async function readMediaState(page) {
  return page.evaluate(() => ({
    pointerFine: matchMedia("(pointer: fine)").matches,
    pointerCoarse: matchMedia("(pointer: coarse)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    touchPoints: navigator.maxTouchPoints,
  }));
}

for (const config of CONFIGS) {
  const context = await browser.newContext(config.context(VIEWPORTS[0]));
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(300_000);
  page.setDefaultTimeout(300_000);

  await config.prepare(page);
  await openStudio(page, `[${config.key}]`);

  // THE CLAIM UNDER TEST. If the context does not actually report the media
  // state this column is about, everything below measures a different branch
  // and every number it prints is true and irrelevant. That is HARNESS_ERROR,
  // not a pass.
  const media = await readMediaState(page);
  const claimOk = Object.entries(config.expect).every(([key, want]) => media[key] === want);
  if (!claimOk) {
    await context.close();
    await browser.close();
    throw new Error(
      `the [${config.key}] context does not report ${config.mediaLabel} - ` +
        Object.entries(config.expect)
          .map(([key, want]) => `${key}=${media[key]} (wanted ${want})`)
          .join(", ") +
        `. The ${config.key} branch would NOT be measured.`,
    );
  }

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    // Let media/container queries settle before reading boxes.
    await page.waitForTimeout(900);

    const m = await measure(page);
    if (m.topbar == null) {
      await context.close();
      await browser.close();
      throw new Error(
        `studio shell absent at ${vp.w}x${vp.h} (${config.key}) - measurement aborted, not reported as a collapsed sequencer`,
      );
    }
    const rows = REGIONS.map((r) => ({ label: r.label, px: m[r.key]?.h ?? null, weight: r.weight }));
    report.push({ config, vp, m, text: table(rows, vp.w, vp.h) });

    if (SHOTS) {
      await page.screenshot({
        path: resolve(outDir, `proportion-${config.key}-${vp.w}x${vp.h}.png`),
      });
    }
  }
  await context.close();
}

await browser.close();

/**
 * THE CHECKS.
 *
 * Per measurement:
 *   overflow      the document is wider than the viewport
 *   collapsed     the sequencer lost its body
 *   pitchMiss     the CSS row box is TALLER than the slot the component reserves
 *   wrongConstant the component published the WRONG branch's row pitch
 *   motion        the reduced-motion column must zero every transition, and
 *                 the other columns must NOT (otherwise the check is vacuous)
 */
const failures = [];
const overflow = report.filter((r) => r.m.docWidth > r.m.vw);
const collapsed = report.filter((r) => r.m.sequencer == null || r.m.sequencer.h < 40);
// The STYLESHEET's row box vs the COMPONENT's constant. Two independent
// sources. Deliberately NOT the rendered pitch, which is derived from that same
// constant and would make the check a tautology.
const pitchMiss = report.filter((r) => r.m.rowBoxOverlapsSlot === true);
const wrongConstant = report.filter((r) => r.m.rowPitchAssumed !== r.config.expectRowPitch);
// The reduced-motion column must actually be reduced, and the others must not
// be: a shell that stopped animating everywhere would satisfy "0s" without
// the accessibility branch doing anything.
const motion = report.filter((r) => {
  const reduced = r.config.expect.reducedMotion;
  const seconds = r.m.maxTransitionSeconds ?? 0;
  return reduced ? seconds > 0 : seconds === 0;
});

console.log("\n=== KYX studio shell - vertical budget (5 viewports x 3 media branches) ===\n");
for (const config of CONFIGS) {
  const rows = report.filter((r) => r.config.key === config.key);
  console.log(`\n--- ${config.label} (${config.mediaLabel}) ---\n`);
  for (const r of rows) {
    console.log(r.text);
    console.log(
      `  doc ${r.m.docWidth}px vs viewport ${r.m.vw}px ${r.m.docWidth > r.m.vw ? "  <-- HORIZONTAL OVERFLOW" : ""}`,
    );
    console.log(
      `  sequencer rows ${r.m.sequencerRows ?? 0}, visible ${r.m.sequencerVisibleRows ?? 0}; ` +
        `row box ${r.m.rowBoxHeight ?? "?"}px (margin ${r.m.rowMarginBottom ?? 0}px) in slot TS ${r.m.rowPitchAssumed ?? "?"}px` +
        `${r.m.rowPitchAssumed !== r.config.expectRowPitch ? `  <-- EXPECTED ${r.config.expectRowPitch}px` : ""}`,
    );
    console.log(
      `  longest transition ${r.m.maxTransitionSeconds ?? "?"}s over ${r.m.animatedElementsSampled ?? 0} sampled elements` +
        `${r.config.expect.reducedMotion ? "  (reduced motion: must be 0s)" : "  (must be > 0s)"}`,
    );
    console.log("");
  }
}

if (overflow.length) {
  console.log(`FAIL: horizontal overflow at ${overflow.map((r) => `${r.config.key} ${r.vp.w}x${r.vp.h}`).join(", ")}`);
}
if (collapsed.length) {
  console.log(
    `FAIL: sequencer collapsed at ${collapsed.map((r) => `${r.config.key} ${r.vp.w}x${r.vp.h} (${r.m.sequencer?.h ?? "missing"}px)`).join(", ")}`,
  );
}
if (pitchMiss.length) {
  console.log(
    "FAIL: the CSS row box is TALLER than the slot Sequencer.tsx reserves - each row overlaps the next by the excess, and the excess accumulates down the list. " +
      pitchMiss
        .map(
          (r) =>
            `${r.config.key} ${r.vp.w}x${r.vp.h}: row box ${r.m.rowBoxHeight}px in slot TS ${r.m.rowPitchAssumed}px`,
        )
        .join("; "),
  );
}
if (wrongConstant.length) {
  console.log(
    "FAIL: Sequencer.tsx published the wrong branch's ROW_HEIGHT. " +
      wrongConstant
        .map(
          (r) =>
            `${r.config.key} ${r.vp.w}x${r.vp.h}: published ${r.m.rowPitchAssumed}px, ${r.config.mediaLabel} must publish ${r.config.expectRowPitch}px`,
        )
        .join("; "),
  );
}
if (motion.length) {
  console.log(
    "FAIL: the motion branch did not take effect. " +
      motion
        .map(
          (r) =>
            `${r.config.key} ${r.vp.w}x${r.vp.h}: longest transition ${r.m.maxTransitionSeconds}s over ${r.m.animatedElementsSampled} sampled elements` +
            (r.config.expect.reducedMotion
              ? " — prefers-reduced-motion: reduce must zero every transition (src/styles/50-motion-accessibility.css)"
              : " — the shell must still animate, otherwise the reduced-motion check would pass vacuously"),
        )
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
const failed = overflow.length || collapsed.length || pitchMiss.length || wrongConstant.length || motion.length;
if (!failed) {
  console.log(
    `PASS: ${report.length} measurements (${CONFIGS.length} media branch(es) x ${VIEWPORTS.length} viewports) - ` +
      "no overflow, sequencer present everywhere, row pitch matches the virtualizer on every branch, motion branch effective",
  );
}
process.exit(failed ? EXIT_GATE_FAILED : 0);
