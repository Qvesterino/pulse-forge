/**
 * ui-camera.mjs — what the sequencer actually COSTS while it plays.
 *
 * THE QUESTION THIS ANSWERS
 * --------------------------
 * docs/STUDIO-OPTIMIZATION-PLAN.md §5.3 lists three things that were "neoverené"
 * (unverified) and assigns them to a camera:
 *
 *   - how many rows re-render during playback (the meter runs at 60 fps);
 *   - whether the badges drag the whole row;
 *   - 16 channels x 16 steps = 256 cells, with a peak decay on top.
 *
 * "Unverified" is the dangerous word: the shell LOOKS cheap because the step
 * cells are memoized and the row label subscribes to its OWN pad's peak
 * (src/ui/padChannelState.ts). Reading that code gives a hypothesis, not a
 * measurement. This script measures it in a live browser.
 *
 * HOW IT MEASURES
 * ---------------
 * A MutationObserver on the sequencer subtree, bucketed by WHAT changed:
 *
 *   meter     the meter fill's style     -> a row re-rendered because its peak moved
 *   badge     the rate/synth badge        -> a badge was rewritten
 *   playhead  the playhead column class  -> the playhead moved (expected)
 *   stepCell  anything inside a .step    -> one of the 256 cells was touched
 *   steps     anything else in the grid  -> the grid itself changed
 *   label     the channel name            -> the name was rewritten
 *   other     everything else
 *
 * plus a requestAnimationFrame counter (the frame rate the user actually gets)
 * and a PerformanceObserver for long tasks (the frame budget).
 *
 * The playhead is a CLASS on the cells of one column, so it shows up as a
 * class mutation on a `.step`. Reading the old value as well is what keeps
 * the cell that LOST the class from being filed as a cell that was
 * re-rendered — otherwise the playhead looks like 256 re-rendered cells.
 *
 * WHY DOM MUTATIONS AND NOT REACT RENDERS
 * ----------------------------------------
 * React re-renders a component without touching the DOM when the output is
 * identical, so a React render count would overstate the work the user pays.
 * The DOM is the thing that costs paint and layout. The one thing the DOM
 * cannot see is the React work of re-creating an identical badge element —
 * that is why the report states both the mutation count AND what the source
 * says about the component boundary, instead of pretending the DOM answers
 * everything.
 *
 * THE THREE PHASES (each one is a control for the next)
 * ------------------------------------------------------
 *   1. BASELINE   the transport is stopped. The meter must not move at all.
 *                 Without this, "the meter moved during playback" could just
 *                 be "the app is alive".
 *   2. PLAYBACK   the transport runs. The meter must move (otherwise the
 *                 measurement is vacuous -> HARNESS_ERROR, not a pass), the
 *                 badges must NOT move, and the 256 cells must NOT move.
 *   3. BADGE      the transport is stopped and the "16 LEVELS" badge is
 *                 toggled. The badges MUST move, and the 256 cells still must
 *                 NOT. That is the plan's second question, measured: a badge
 *                 rewrite costs the label, not the grid.
 *
 * EXIT CODES (the same discipline as the other gates)
 *   0 = the camera ran and the budgets held
 *   1 = the camera ran and a budget was broken
 *   2 = HARNESS_ERROR — the camera could not observe what it came to observe
 *
 * USAGE
 *   node scripts/ui-camera.mjs [--url http://127.0.0.1:5173] [--seconds 4]
 */

import { chromium } from "playwright";
import { bootStudio } from "./lib/studio-boot.mjs";

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf("--url");
const URL = urlIndex >= 0 ? argv[urlIndex + 1] : "http://127.0.0.1:5173";
const secondsIndex = argv.indexOf("--seconds");
const SECONDS = secondsIndex >= 0 ? Number(argv[secondsIndex + 1]) : 4;

const EXIT_GATE_FAILED = 1;
const EXIT_HARNESS_ERROR = 2;

/**
 * The frame-rate budget is RELATIVE, not absolute: playback must not cost more
 * than a fifth of the frame rate the same machine manages with the transport
 * stopped. An absolute "60 fps" would fail on a slow CI runner for reasons
 * that have nothing to do with the sequencer.
 */
const FPS_TOLERANCE = 0.8;

/** A task longer than this is a dropped frame. */
const LONG_TASK_MS = 50;

process.on("uncaughtException", (error) => {
  console.error(`\nHARNESS_ERROR ${error?.message ?? error}`);
  console.error("The camera did not complete. NOT a gate result - nothing was checked.");
  process.exit(EXIT_HARNESS_ERROR);
});

/**
 * Install the camera in the page. It is installed AFTER the studio is up, so
 * the `.sequencer` element exists and the observer has something to watch.
 */
async function installCamera(page) {
  await page.evaluate(() => {
    const PLAYHEAD_CLASS = /\bplayhead\b/;

    const camera = {
      active: false,
      frameIndex: 0,
      frames: 0,
      maxGapMs: 0,
      lastFrameAt: 0,
      startedAt: 0,
      counts: { meter: 0, badge: 0, playhead: 0, stepCell: 0, steps: 0, label: 0, other: 0 },
      targets: new Map(),
      playheadCells: new Set(),
      maxPlayheadCells: 0,
      rows: new Set(),
      rowsPerFrame: [],
      longTasks: [],
      rafId: null,
    };

    const elementOf = (node) => (node instanceof Element ? node : (node?.parentElement ?? null));

    /** WHAT changed — this is the whole measurement. */
    const classify = (record) => {
      const el = elementOf(record.target);

      // 1. THE PLAYHEAD COLUMN. The playhead is a CLASS on the cells of one
      //    column, so it shows up as a class mutation on a `.step`. Reading
      //    the OLD value as well is what keeps the cell that LOST the class
      //    from being filed as a cell that was re-rendered.
      if (record.type === "attributes" && record.attributeName === "class") {
        const hadIt = PLAYHEAD_CLASS.test(record.oldValue ?? "");
        const hasIt = el ? PLAYHEAD_CLASS.test(el.getAttribute("class") ?? "") : false;
        if (hadIt || hasIt) return "playhead";
      }
      // 2. The playhead ELEMENT itself (its --playhead-frac).
      if (el?.closest?.(".seq-playhead")) return "playhead";

      // 3. A STEP CELL — anything inside a `.step` that is not the playhead.
      //    This is the number the plan cares about: 16 channels x 16 steps.
      if (el?.closest?.(".step")) return "stepCell";

      // 4. The meter fill — a row re-rendered because its own peak moved.
      if (el?.matches?.(".row-pad-meter-fill")) return "meter";

      // 5. The badges. A badge that was ADDED or REMOVED is a childList
      //    record whose TARGET is the button, not the badge; looking only at
      //    the target would file every badge toggle under "other" and hide
      //    the answer.
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        const candidate = elementOf(node);
        if (candidate?.matches?.(".row-pad-rate-badge, .pad-synth-badge")) return "badge";
      }
      if (el?.closest?.(".row-pad-rate-badge, .pad-synth-badge")) return "badge";
      if (el?.closest?.(".row-steps")) return "steps";
      if (el?.closest?.(".row-pad-name")) return "label";
      return "other";
    };

    /** A readable name for the element that changed, and WHICH attribute. */
    const describe = (record) => {
      const el = elementOf(record.target);
      const base = (() => {
        if (!el) return String(record.target?.nodeName ?? "?").toLowerCase();
        const cls = (el.getAttribute?.("class") ?? "").trim().split(/\s+/).filter(Boolean);
        const tag = el.tagName.toLowerCase();
        return cls.length ? `${tag}.${cls.slice(0, 2).join(".")}` : tag;
      })();
      // The attribute name is half the diagnosis: "the overlay changed" is a
      // question, "the overlay's style changed" is an answer.
      const attr = record.type === "attributes" ? ` [${record.attributeName}]` : "";
      return `${base}${attr}`;
    };

    const observer = new MutationObserver((records) => {
      if (!camera.active) return;
      for (const record of records) {
        const kind = classify(record);
        camera.counts[kind] += 1;
        const key = `${kind} · ${describe(record)}`;
        camera.targets.set(key, (camera.targets.get(key) ?? 0) + 1);
        const el = elementOf(record.target);
        if (kind === "playhead" && el?.closest?.(".step")) camera.playheadCells.add(el.closest(".step"));
        const row = el?.closest?.(".sequencer-row") ?? null;
        if (row) {
          camera.rows.add(row);
          let bucket = camera.rowsPerFrame[camera.frameIndex];
          if (!bucket) {
            bucket = new Set();
            camera.rowsPerFrame[camera.frameIndex] = bucket;
          }
          bucket.add(row);
        }
      }
    });
    observer.observe(document.querySelector(".sequencer"), {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      childList: true,
    });

    const tick = (t) => {
      if (!camera.active) return;
      camera.frameIndex += 1;
      camera.frames += 1;
      if (camera.lastFrameAt) camera.maxGapMs = Math.max(camera.maxGapMs, t - camera.lastFrameAt);
      camera.lastFrameAt = t;
      // The playhead is a COLUMN: at any moment one cell per row carries the
      // class. Counting the cells that EVER carried it over the window would
      // count the whole grid (the playhead sweeps the pattern), so the
      // invariant is the CONCURRENT count.
      const marked = document.querySelectorAll(".step.playhead").length;
      if (marked > camera.maxPlayheadCells) camera.maxPlayheadCells = marked;
      camera.rafId = requestAnimationFrame(tick);
    };

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          camera.longTasks.push({
            duration: Math.round(entry.duration),
            // WHEN it happened, relative to the window start. A one-time cost
            // at the start of playback and a periodic cost look identical in a
            // count and completely different in a verdict.
            at: Math.round(performance.now() - camera.startedAt),
          });
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask is not supported everywhere - the long-task budget then rests on the frame gap */
    }

    window.__camera = {
      /**
       * WHICH BUILD did we measure? The loaded chunk names come from the
       * resource timing entries. A gate that cannot say which build it
       * measured cannot be trusted when two runs disagree.
       */
      fingerprint() {
        const resources = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /\.(js|css)$/.test(name))
          .map((name) => name.split("/").pop());
        return {
          scripts: resources.filter((name) => name.endsWith(".js")).slice(0, 6),
          styles: resources.filter((name) => name.endsWith(".css")).slice(0, 3),
        };
      },
      /** The ruler's loop overlay, as the DOM shows it right now. */
      overlay() {
        const el = document.querySelector(".ruler-loop-overlay");
        if (!el) return null;
        return {
          visible: el.getAttribute("data-visible"),
          left: el.style.left,
          width: el.style.width,
        };
      },
      start() {
        camera.active = true;
        camera.frames = 0;
        camera.maxGapMs = 0;
        camera.lastFrameAt = 0;
        camera.frameIndex = 0;
        camera.startedAt = performance.now();
        camera.counts = { meter: 0, badge: 0, playhead: 0, stepCell: 0, steps: 0, label: 0, other: 0 };
        camera.targets = new Map();
        camera.playheadCells = new Set();
        camera.maxPlayheadCells = 0;
        camera.rows = new Set();
        camera.rowsPerFrame = [];
        camera.longTasks = [];
        camera.rafId = requestAnimationFrame(tick);
      },
      stop() {
        camera.active = false;
        if (camera.rafId !== null) cancelAnimationFrame(camera.rafId);
        camera.rafId = null;
        const seconds = Math.max(0.001, (performance.now() - camera.startedAt) / 1000);
        const buckets = camera.rowsPerFrame.filter(Boolean).map((bucket) => bucket.size);
        return {
          seconds: Math.round(seconds * 1000) / 1000,
          frames: camera.frames,
          fps: Math.round((camera.frames / seconds) * 10) / 10,
          maxFrameGapMs: Math.round(camera.maxGapMs),
          counts: { ...camera.counts },
          distinctRows: camera.rows.size,
          playheadCells: camera.playheadCells.size,
          maxPlayheadCells: camera.maxPlayheadCells,
          rowsPerFrameMax: buckets.length ? Math.max(...buckets) : 0,
          rowsPerFrameTotal: buckets.reduce((sum, size) => sum + size, 0),
          rowSamples: buckets.length,
          longTasks: camera.longTasks.slice(),
          topTargets: [...camera.targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
        };
      },
    };
  });
}

/**
 * Open the studio, with ONE retry.
 *
 * The boot itself (the disclosure fight and the template click) is known to be
 * flaky: one run in three lost the race and the template click timed out.
 * A retry here does NOT change what is measured — it only decides whether the
 * camera gets to observe at all. If both attempts fail, the run ends as
 * HARNESS_ERROR, which says exactly that: nothing was checked.
 */
async function openStudio(context) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(300_000);
    page.setDefaultTimeout(300_000);
    try {
      await bootStudio(page, URL, { label: "[camera]" });
      return page;
    } catch (error) {
      lastError = error;
      await page.close().catch(() => {});
      if (attempt < 2)
        console.log(`[camera] boot attempt ${attempt} failed (${error?.message ?? error}) - retrying once`);
    }
  }
  throw lastError;
}

async function main() {
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await openStudio(context);

  await installCamera(page);

  const rowCount = await page.evaluate(() => document.querySelectorAll(".sequencer-row").length);
  if (!rowCount) {
    await browser.close();
    throw new Error("the sequencer has no rows - there is nothing to photograph");
  }
  // WHICH BUILD did we measure? The hashed chunk names are the build's
  // identity: a gate that cannot say which build it measured cannot be
  // trusted when two runs disagree.
  const fingerprint = await page.evaluate(() => window.__camera.fingerprint());
  const overlay = await page.evaluate(() => window.__camera.overlay());
  console.log(`\n  build: ${fingerprint.scripts.join(", ")}`);
  console.log(`  ruler loop overlay: ${JSON.stringify(overlay)}\n`);
  // The step cells of ONE row: the plan's "16 channels x 16 steps" is this
  // number times the row count.
  const cellsPerRow = await page.evaluate(() => {
    const row = document.querySelector(".sequencer-row");
    return row ? row.querySelectorAll(".step").length : 0;
  });

  // ── Phase 1: BASELINE (transport stopped) ───────────────────────────────
  await page.evaluate(() => window.__camera.start());
  await page.waitForTimeout(SECONDS * 1000);
  const baseline = await page.evaluate(() => window.__camera.stop());

  // ── Phase 2: PLAYBACK ───────────────────────────────────────────────────
  await page.locator(".btn-play").first().click({ timeout: 30_000 });
  // The claim under test: the transport really is running. `.btn-play.active`
  // is the shell's own "playing" state, so this cannot silently measure a
  // stopped transport.
  await page.waitForFunction(() => document.querySelector(".btn-play")?.classList.contains("active"), undefined, {
    timeout: 30_000,
    polling: 100,
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__camera.start());
  await page.waitForTimeout(SECONDS * 1000);
  const playback = await page.evaluate(() => window.__camera.stop());

  // ── Phase 3: BADGE (transport stopped, the badge is toggled) ────────────
  await page
    .locator(".btn-stop")
    .first()
    .click({ timeout: 30_000 })
    .catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__camera.start());
  await page.locator(".rack-header-toggle").first().click({ timeout: 30_000 });
  await page.waitForTimeout(700);
  const badge = await page.evaluate(() => window.__camera.stop());
  // Toggle it back, so the studio is left as the camera found it.
  await page
    .locator(".rack-header-toggle")
    .first()
    .click({ timeout: 30_000 })
    .catch(() => {});

  await browser.close();

  // ── The report ──────────────────────────────────────────────────────────
  console.log("\n=== KYX studio camera — what the sequencer costs while it plays ===\n");
  console.log(
    `rows in the sequencer: ${rowCount} · step cells per row: ${cellsPerRow} (${rowCount * cellsPerRow} in the grid)\n`,
  );
  const line = (label, r) =>
    `  ${label.padEnd(20)} frames ${String(r.frames).padStart(4)}  fps ${String(r.fps).padStart(5)}  ` +
    `gap ${String(r.maxFrameGapMs).padStart(4)}ms  ` +
    `meter ${String(r.counts.meter).padStart(5)}  badge ${String(r.counts.badge).padStart(4)}  ` +
    `cell ${String(r.counts.stepCell).padStart(5)}  playhead ${String(r.counts.playhead).padStart(5)}  ` +
    `steps ${String(r.counts.steps).padStart(4)}  label ${String(r.counts.label).padStart(3)}  ` +
    `other ${String(r.counts.other).padStart(5)}  ` +
    `rows ${String(r.distinctRows).padStart(3)} (max ${String(r.rowsPerFrameMax).padStart(2)}/frame)`;
  console.log(line("baseline (stopped)", baseline));
  console.log(line("playback", playback));
  console.log(line("badge toggle", badge));
  console.log(
    `  long tasks (>${LONG_TASK_MS}ms): baseline ${baseline.longTasks.length}, playback ${playback.longTasks.length}, badge ${badge.longTasks.length}`,
  );
  for (const [name, report] of [
    ["baseline", baseline],
    ["playback", playback],
    ["badge", badge],
  ]) {
    if (!report.longTasks.length) continue;
    console.log(`    ${name}: ${report.longTasks.map((t) => `${t.duration}ms @${t.at}ms`).join(", ")}`);
  }
  console.log(
    `  the playhead visited ${playback.playheadCells} of ${rowCount * cellsPerRow} cells over the window, ` +
      `and at most ${playback.maxPlayheadCells} carried it at once (one column = ${rowCount} cells)\n`,
  );
  for (const [name, report] of [
    ["baseline", baseline],
    ["playback", playback],
    ["badge", badge],
  ]) {
    console.log(`  top movers (${name}):`);
    for (const [key, count] of report.topTargets) console.log(`    ${String(count).padStart(6)}  ${key}`);
  }
  console.log("");

  // ── The budgets ─────────────────────────────────────────────────────────
  const failures = [];

  if (playback.counts.meter === 0) {
    // The camera came to watch the meter move and the meter did not move. That
    // is not a pass: every other number below would be true and irrelevant.
    console.error(
      "HARNESS_ERROR: the meter never moved during playback. The transport ran (the play button " +
        "reported 'active'), but no peak reached a row, so the camera measured nothing.",
    );
    process.exit(EXIT_HARNESS_ERROR);
  }

  if (baseline.counts.meter !== 0) {
    failures.push(
      `the meter moved while the transport was STOPPED (${baseline.counts.meter} mutations) - ` +
        "the playback numbers below would not be attributable to playback",
    );
  }
  // With the transport stopped, the sequencer has nothing to say. ANY DOM
  // write is a task the user pays for and nobody asked for - and this is the
  // budget that catches them: it found a per-frame `data-visible` write on
  // the ruler's loop overlay (1420 mutations in a 4s window, for a value that
  // never changed).
  const baselineTotal = Object.values(baseline.counts).reduce((sum, count) => sum + count, 0);
  if (baselineTotal !== 0) {
    failures.push(
      `${baselineTotal} DOM mutations while the transport was STOPPED ` +
        `(${baseline.topTargets.map(([key, count]) => `${count}x ${key}`).join("; ")}) - ` +
        "a stopped sequencer must not touch the DOM at all",
    );
  }
  if (playback.counts.badge !== 0) {
    failures.push(
      `${playback.counts.badge} badge mutations during playback - the meter is dragging the badges, ` +
        "so every live row rewrites the badge DOM 60 times a second",
    );
  }
  if (playback.counts.stepCell !== 0) {
    failures.push(
      `${playback.counts.stepCell} mutations inside a STEP CELL during playback - the memoized cells ` +
        `are being re-rendered; ${rowCount} channels x ${cellsPerRow} steps is ${rowCount * cellsPerRow} cells`,
    );
  }
  if (playback.maxPlayheadCells > rowCount) {
    failures.push(
      `${playback.maxPlayheadCells} cells carried the playhead class at the same time - it is ONE ` +
        `column, i.e. at most ${rowCount} cells (one per row), not the grid`,
    );
  }
  if (playback.distinctRows > rowCount) {
    failures.push(`${playback.distinctRows} rows were touched but the sequencer only has ${rowCount}`);
  }
  if (playback.longTasks.length > 0) {
    failures.push(
      `${playback.longTasks.length} long tasks during playback (${playback.longTasks
        .map((t) => `${t.duration}ms @${t.at}ms`)
        .join(", ")}) - a task over ${LONG_TASK_MS}ms is a dropped frame`,
    );
  }
  if (playback.fps < baseline.fps * FPS_TOLERANCE) {
    failures.push(
      `playback ran at ${playback.fps} fps against a ${baseline.fps} fps baseline - the sequencer cost ` +
        `more than ${Math.round((1 - FPS_TOLERANCE) * 100)}% of the frame rate`,
    );
  }

  if (badge.counts.badge === 0) {
    failures.push(
      "the badge toggle changed no badge - the badge experiment measured nothing, so the claim " +
        "'a badge does not drag the row' would be vacuous",
    );
  }
  if (badge.counts.stepCell !== 0 || badge.counts.steps !== 0) {
    failures.push(
      `${badge.counts.stepCell + badge.counts.steps} mutations inside the step grid when the badge was ` +
        "toggled - a badge rewrite IS dragging the cells",
    );
  }
  if (badge.distinctRows > rowCount) {
    failures.push(`the badge touched ${badge.distinctRows} rows, but the sequencer only has ${rowCount}`);
  }

  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length === 0) {
    console.log(
      `PASS: the camera observed ${SECONDS}s of playback over ${rowCount} rows - ` +
        `${playback.counts.meter} meter updates, ${playback.counts.badge} badge rewrites, ` +
        `${playback.counts.stepCell} step-cell mutations, ${playback.counts.playhead} playhead moves ` +
        `(over ${playback.playheadCells} distinct cells), ${playback.longTasks.length} long tasks, ` +
        `${playback.fps} fps against a ${baseline.fps} fps baseline.`,
    );
  }
  process.exit(failures.length ? EXIT_GATE_FAILED : 0);
}

await main();
