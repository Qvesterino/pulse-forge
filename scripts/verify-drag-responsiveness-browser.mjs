/**
 * DRAG RESPONSIVENESS — the flagship canvases, measured in a REAL browser.
 *
 * Audit 16 (2026-10-16) fixed three canvas gestures that wrote the DOCUMENT on
 * every pointermove (Rezonans formant, Ozvena blend pad, Skrutka curve). The
 * fix was proven two ways, both inside jsdom: a regression spec whose negative
 * assertion ("pointermove must not write the document") and a falsification
 * that turned it red. Neither of those can see the real thing: they use a
 * stubbed engine and no AudioWorklet, no layout, no real clock.
 *
 * This script closes that layer WITHOUT TOUCHING PRODUCTION CODE. It drives the
 * real studio UI with real mouse input and attributes main-thread samples with
 * the Chrome DevTools Protocol CPU profiler, bucketed by source module:
 *
 *   document-write  →  src/store + src/commands + src/project-model
 *
 * A gesture that writes the document N times spends its time in exactly those
 * modules. A gesture that previews through the runtime and commits once does
 * not. That is the whole measurement.
 *
 * Two guards make the result mean something (a clean profile from a dead panel
 * would look identical to a clean profile from a fast one):
 *
 *   LIVENESS   the canvas bitmap changes across the drag — the panel really
 *              processed the gesture and really repainted.
 *   COMMIT     the persisted project document's focusHz changes after release —
 *              the drag reached the document, once, through the normal path.
 *
 * Usage:  npm run test:browser:drag-responsiveness        (PORT overrides 5261)
 * Exit 0 = the canvas gesture stayed inside the document-write budget.
 *
 * Note on instrument choice: long-task and frame-jank observers were rejected.
 * The audit measured ~1.76 ms of store work per pointermove — an order of
 * magnitude BELOW the 50 ms longtask threshold, and far under a dropped frame.
 * A "no jank" assertion would have passed with the defect present. Counting
 * where the main thread actually spends its time is the honest measurement.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A probe that computes its root wrong hands the tool a much larger scope than
// the project — a file in the repo ROOT resolves to the drive, and Vite then
// dep-scans the entire disk. Fail loudly instead.
const driveRoot = path.parse(root).root.toUpperCase();
if (root.toUpperCase() === driveRoot) {
  throw new Error("root escaped the project — refusing to serve from " + root);
}
const PORT = Number(process.env.PORT) || 5261;
// This repo's dev boot is genuinely slow on a cold Vite cache: the first
// response transforms the whole app graph. 120 s was not enough here, so the
// waits below are deliberately generous — a timeout here would be a false
// negative, not a signal about drag cost.
const navTimeout = Number(process.env.NAV_TIMEOUT_MS) || 300_000;

/** CPU sampling interval, microseconds. 100 µs resolves a ~2 ms gesture. */
const SAMPLING_INTERVAL_US = Number(process.env.DRAG_SAMPLING_US) || 100;

/** Mouse steps per drag. A real 60-Hz drag of one second is ~60 samples. */
const DRAG_STEPS = Number(process.env.DRAG_STEPS) || 60;

/**
 * Budget for the document-write share of main-thread samples during ONE drag.
 * Calibrated from the first real measurement, not guessed — see
 * docs/audits/2026-10-16-ui-responsiveness/RISK-CLOSURE-PLAN.md.
 * Pre-fix behaviour put the dominant cost in this bucket; post-fix it is a
 * single commit at release.
 */
const DOC_WRITE_BUDGET_PCT = Number(process.env.DRAG_DOC_WRITE_BUDGET_PCT) || 25;

/** Main-thread buckets we care about. Everything under /src/ is counted too. */
const BUCKETS = [
  { id: "document-write", re: /\/src\/(?:store|commands|project-model)\// },
  { id: "skrutka-panel", re: /\/src\/ui\/SkrutkaPanel/ },
  { id: "engine", re: /\/src\/audio-engine\// },
];

/**
 * Aggregate a CDP CPU profile into per-module self time.
 * `nodes[].hitCount` is already the sample count per node, so summing is exact
 * — no need to walk `samples`/`timeDeltas`.
 */
function aggregateProfile(profile) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b.id, 0]));
  let srcSamples = 0;
  let totalSamples = 0;
  for (const node of profile?.nodes ?? []) {
    const hits = node.hitCount ?? 0;
    if (!hits) continue;
    totalSamples += hits;
    const url = node.callFrame?.url ?? "";
    // Only application frames are meaningful; browser internals would drown them.
    if (!url.includes("/src/")) continue;
    srcSamples += hits;
    for (const b of BUCKETS) if (b.re.test(url)) buckets[b.id] += hits;
  }
  const pct = (n) => (srcSamples > 0 ? Number(((100 * n) / srcSamples).toFixed(2)) : 0);
  return {
    totalSamples,
    srcSamples,
    wallSharePct: totalSamples > 0 ? Number(((100 * srcSamples) / totalSamples).toFixed(2)) : 0,
    buckets,
    bucketPct: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, pct(v)])),
  };
}

/** Run `fn` under the CDP CPU profiler. */
async function profileGesture(cdp, fn) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: SAMPLING_INTERVAL_US });
  await cdp.send("Profiler.start");
  const started = Date.now();
  await fn();
  const wallMs = Date.now() - started;
  const { profile } = await cdp.send("Profiler.stop");
  return { ...aggregateProfile(profile), wallMs };
}

/**
 * A drag with the SHAPE of a real one: press, walk across in steps with both
 * axes moving (Skrutka reads x as FOCUS and y as DISPERSION), release.
 */
async function dragCurve(page, box, steps = DRAG_STEPS) {
  const y0 = box.y + box.height * 0.5;
  const x0 = box.x + box.width * 0.2;
  const x1 = box.x + box.width * 0.8;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const legs = 6;
  const perLeg = Math.max(1, Math.round(steps / legs));
  for (let i = 1; i <= legs; i++) {
    const t = i / legs;
    await page.mouse.move(x0 + (x1 - x0) * t, y0 + (y0 - box.y) * 0.18 * Math.sin(t * Math.PI), {
      steps: perLeg,
    });
  }
  await page.mouse.up();
}

/** Cheap checksum of the canvas bitmap — proves the panel repainted. */
async function canvasFingerprint(page, selector) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) return null;
    // toDataURL on a WebGL-less 2D canvas is a snapshot of what was drawn.
    const data = c.toDataURL();
    let h = 0;
    for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) | 0;
    return { length: data.length, hash: h };
  }, selector);
}

/**
 * Read the persisted project's skrutka focusHz straight out of IndexedDB.
 * This is the COMMIT proof: it is the document the app would reload, not a
 * React render, so it cannot be fooled by a preview that never committed.
 */
async function persistedSkrutkaFocus(page) {
  return page.evaluate(async () => {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("pulse-forge");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction("projects", "readonly");
        const req = tx.objectStore("projects").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      // Defensive walk: the repository's record shape is not this script's
      // contract, so find the skrutka instance wherever it sits.
      let focus = null;
      const seen = new Set();
      const visit = (node, depth) => {
        if (focus !== null || node === null || typeof node !== "object" || depth > 8) return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
          for (const item of node) visit(item, depth + 1);
          return;
        }
        if (node.type === "skrutka" && node.params && typeof node.params.focusHz === "number") {
          focus = node.params.focusHz;
          return;
        }
        for (const value of Object.values(node)) visit(value, depth + 1);
      };
      for (const row of rows) visit(row, 0);
      return focus;
    } catch (error) {
      return { error: String(error).slice(0, 120) };
    }
  });
}

/** Autosave is debounced — poll for the commit instead of guessing a delay. */
async function waitForCommittedFocus(page, previous, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let current = await persistedSkrutkaFocus(page);
  while (Date.now() < deadline) {
    current = await persistedSkrutkaFocus(page);
    if (typeof current === "number" && current !== previous) return current;
    await page.waitForTimeout(200);
  }
  return current;
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

let browser;
let exitCode = 0;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Skip the landing page and the first-run tour — this pass is about dragging,
  // not about onboarding.
  await context.addInitScript(() => {
    localStorage.setItem("pf-onboarded", "1");
    localStorage.setItem("pf-tour-v1", "1");
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: navTimeout });

  // Boot recipe mirrored from verify-browser.mjs, which already carries a
  // "mount retry" for this repo's slow cold mount.
  let mountRetry = false;
  await page
    .waitForSelector(".landing, .project-browser", { timeout: navTimeout })
    .catch(async () => {
      if (mountRetry) throw new Error("mount retry also timed out");
      mountRetry = true;
      await page.reload({ waitUntil: "domcontentloaded", timeout: navTimeout });
      return page.waitForSelector(".landing, .project-browser", { timeout: navTimeout });
    });
  if (await page.$(".landing")) {
    await page.waitForSelector(".landing-hero-player .embed-play", { timeout: navTimeout });
    await page.evaluate(() => document.querySelector(".landing-nav button.landing-btn-primary")?.click());
  }
  await page.waitForSelector(".project-browser", { timeout: navTimeout });
  await page.evaluate(() => document.querySelectorAll(".pb-template")[0]?.click());
  await page.waitForSelector(".topbar", { timeout: navTimeout });
  await page.waitForSelector(".sequencer", { timeout: navTimeout });

  // Open the device chain and add TWIST (SKRUTKA) to the selected track.
  await page.locator('.dock-tabs button[aria-label="Toggle track device chain"]').first().click();
  await page.waitForSelector(".devices-panel", { timeout: 60_000 });
  await page.locator(".devices-add-effect").first().selectOption("skrutka");
  await page.waitForSelector(".fx-device", { timeout: 60_000 });
  await page.locator(".fx-device").first().click();
  await page.waitForSelector("canvas.skrutka-viz", { timeout: 60_000 });

  const cdp = await context.newCDPSession(page);
  const before = await canvasFingerprint(page, "canvas.skrutka-viz");
  const focusBefore = await persistedSkrutkaFocus(page);

  const measured = await profileGesture(cdp, async () => {
    const box = await page.locator("canvas.skrutka-viz").boundingBox();
    await dragCurve(page, box);
  });

  const after = await canvasFingerprint(page, "canvas.skrutka-viz");
  const focusAfter = await waitForCommittedFocus(page, focusBefore);

  // GUARD 1 — liveness. A panel that ignored the gesture would profile clean.
  const repainted = !!before && !!after && (before.hash !== after.hash || before.length !== after.length);
  // GUARD 2 — commit. The gesture must have reached the persisted document.
  const committed =
    typeof focusBefore === "number" && typeof focusAfter === "number" && focusAfter !== focusBefore;

  const withinBudget = measured.bucketPct["document-write"] <= DOC_WRITE_BUDGET_PCT;

  console.log("\n[drag-responsiveness] TWIST curve drag, " + DRAG_STEPS + " pointer samples");
  console.log("  wall time                 " + measured.wallMs + " ms");
  console.log("  app share of main thread  " + measured.wallSharePct + " % (" + measured.srcSamples + " samples)");
  console.log("  document-write            " + measured.bucketPct["document-write"] + " %  (budget " + DOC_WRITE_BUDGET_PCT + " %)");
  console.log("  skrutka-panel             " + measured.bucketPct["skrutka-panel"] + " %");
  console.log("  engine                    " + measured.bucketPct["engine"] + " %");
  console.log("  liveness (repainted)      " + (repainted ? "yes" : "NO — the drag did nothing"));
  console.log("  commit (focusHz)          " + focusBefore + " -> " + focusAfter);

  if (!repainted) {
    console.log("[FAIL] liveness guard: the canvas did not change. A clean profile from a dead panel proves nothing.");
    exitCode = 1;
  }
  if (!committed) {
    console.log("[FAIL] commit guard: the drag never reached the persisted document.");
    exitCode = 1;
  }
  if (!withinBudget && exitCode === 0) {
    console.log(
      "[FAIL] document-write share " +
        measured.bucketPct["document-write"] +
        " % exceeds the budget " +
        DOC_WRITE_BUDGET_PCT +
        " % — the canvas is writing the document per pointermove again.",
    );
    exitCode = 1;
  }
  if (exitCode === 0) {
    console.log("[PASS] TWIST curve drag: preview on move, one commit on release, inside budget.");
  }
  if (consoleErrors.length > 0) console.log("  page errors:", consoleErrors.slice(0, 3));
} catch (error) {
  console.error("drag responsiveness verification failed:", error);
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  process.exit(exitCode);
}