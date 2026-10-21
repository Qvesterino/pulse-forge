/**
 * Internal plugin functional audit — real-audio evidence runner.
 *
 * Boots a Vite dev server, opens a real Chromium page, and drives
 * src/plugin-audit-checks.ts phase functions (one evaluate per plugin, so a
 * page reload from a concurrent agent's file save only loses one step).
 * Shared fixtures (sample bank, test signal, base doc) live on `window` and
 * rebuild transparently if the page reloads. The report JSON is rewritten
 * after every step, so even a hard kill leaves complete partial evidence.
 *
 * Usage: node scripts/verify-plugin-audit.mjs  (PORT=5221 override)
 *        KYX_AUDIT_ONLY=delay,chorus node scripts/verify-plugin-audit.mjs
 *        KYX_AUDIT_INSTRUMENTS=kopa node scripts/verify-plugin-audit.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { computeHarnessHash, evaluateAuditGate } from "./lib/plugin-audit-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5221;

const onlyEffects = (process.env.KYX_AUDIT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const onlyInstruments = (process.env.KYX_AUDIT_INSTRUMENTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const auditSuffix = [
  ...(onlyEffects.length > 0 ? [`effects-${onlyEffects.join("_")}`] : []),
  ...(onlyInstruments.length > 0 ? [`instruments-${onlyInstruments.join("_")}`] : []),
].join("-");
const outPath = path.join(root, "docs", `plugin-audit-2026-09-27${auditSuffix ? `-${auditSuffix}` : ""}.report.json`);

/**
 * Fingerprint of everything that decides what a number in the report MEANS.
 * Shared with scripts/verify-plugin-audit-quick.mjs via the gate module so the
 * two can never drift apart — a runner that stamps one hash and a gate that
 * checks another would make every report look stale.
 *
 * The audit's whole value is comparing a run against a previous run, so it must
 * be impossible to compare across a change in the measuring code. It was
 * possible, and it did happen: a full run on 2026-10-18 printed
 * `[resume] keeping 56 effect rows, 20 instrument rows` and skipped nearly all
 * of its work, inheriting rows that had been measured while the offline render
 * was returning a truncated buffer (fixed in 9c3ad732). Those rows were not
 * "stale", they were produced by broken code and still satisfied every health
 * filter, because a truncated render is finite.
 */
const harnessHash = computeHarnessHash(root);

const server = await createServer({
  root,
  logLevel: "error",
  // Vite's default dep-scan walks EVERY html file in the tree, and this repo
  // carries a lot of them (coverage/, playwright-report/, docs/audits/…). A
  // stray page that pulls a dependency with a broken exports map (lib0, the
  // yjs transitive dep) makes esbuild fail the whole optimize step, and the
  // audit then dies before a single effect is measured. Pinning the entry to
  // the app's own index.html is the same remedy scripts/render-curated-seeds.mjs
  // and scripts/verify-factory-presets.mjs use.
  optimizeDeps: { entries: ["index.html"] },
  server: {
    port: PORT,
    host: "127.0.0.1",
    strictPort: true,
    // This server exists only to serve modules to the audit page. HMR and the
    // file watcher are off, which is the root-cause fix for the audit dying on
    // "Navigation to ... is interrupted by another navigation": a concurrent
    // agent session saving a file makes Vite push a full-reload, and a reload
    // that lands on top of an in-flight `page.goto` aborts it. Retrying the
    // navigation only loses time while the other session keeps saving — the
    // audit has no reason to take live reloads at all.
    hmr: false,
    watch: null,
  },
});
await server.listen();

// Resume support: an existing report's healthy rows are kept and skipped —
// only missing rows and rows carrying runner/sweep errors are re-rendered.
let report = {
  effects: [],
  instruments: [],
  interactions: null,
  harness: harnessHash,
  startedAt: new Date().toISOString(),
  finishedAt: null,
};
if (fs.existsSync(outPath)) {
  try {
    const prior = JSON.parse(fs.readFileSync(outPath, "utf8"));
    if (prior.harness !== harnessHash) {
      // The measuring code changed, so every number in the prior report means
      // something else now — including the rows that look perfectly healthy.
      console.log(
        `[resume] existing report was measured by a different harness (${prior.harness ?? "unfingerprinted"} ≠ ${harnessHash}) — re-rendering every row`,
      );
    } else {
      report.startedAt = prior.startedAt ?? report.startedAt;
      report.effects = (prior.effects ?? []).filter((e) => !e.sweepError && !e.hostError && e.hostFinite);
      report.instruments = (prior.instruments ?? []).filter(
        (i) => i.defaultAudible && !(i.unstableParams ?? []).some((u) => String(u).startsWith("runner:")),
      );
      const priorInt = prior.interactions;
      const interactionsHealthy =
        priorInt &&
        priorInt.chainRestoreDiff != null &&
        !(priorInt.notes ?? []).some((n) => String(n).startsWith("runner:"));
      report.interactions = interactionsHealthy ? priorInt : null;
      console.log(
        `[resume] keeping ${report.effects.length} effect rows, ${report.instruments.length} instrument rows`,
      );
    }
  } catch {
    console.log("[resume] existing report unreadable — starting fresh");
  }
}
const errors = [];

/**
 * Persist the partial report. This is the audit's crash insurance — the whole
 * reason the report is rewritten after every step — so it must not be the thing
 * that kills the run.
 *
 * Two robustness properties, both bought by observation rather than taste:
 *
 * 1. ATOMIC. Write a sibling temp file and rename over the target. A torn
 *    write would leave a report that parses as valid JSON but is missing rows,
 *    and the resume filter below would then silently skip real work.
 * 2. NON-FATAL + RETRIED. A transient write failure is real on Windows:
 *    measured 2026-10-18 on a full run, `writeFileSync` failed with
 *    `errno -4094 / code UNKNOWN` on a 224 KB file that was exclusively
 *    writable seconds later — a sync client or scanner holding the handle. The
 *    uncaught throw ended the audit and discarded the other 50-odd rows the
 *    run had already paid for. Retry briefly, then record and carry on.
 */
let saveFailures = 0;
function saveReport() {
  const payload = JSON.stringify(report, null, 2);
  const tmpPath = `${outPath}.tmp`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.writeFileSync(tmpPath, payload);
      fs.renameSync(tmpPath, outPath);
      return true;
    } catch (error) {
      if (attempt === 3) {
        saveFailures++;
        const message = `saveReport failed: ${String(error).slice(0, 160)}`;
        errors.push(message);
        console.log(`[audit] ${message} — continuing, partial evidence may be incomplete`);
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          /* best effort */
        }
        return false;
      }
      // Windows transient contention: back off and let the holder release it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * attempt);
    }
  }
  return false;
}

/**
 * Navigate to the audit page, retrying the navigation races.
 *
 * Only navigation-shaped failures are retried. A 404 or a server that never
 * came up is a real failure and must surface immediately — retrying it would
 * burn three minutes to report the same error with more words.
 */
const NAV_RACE = /interrupted|context was destroyed|navigation|timeout|net::ERR_ABORTED|Execution context/i;

async function gotoResilient(page, attempts = 5) {
  const url = `http://127.0.0.1:${PORT}/`;
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
      return;
    } catch (error) {
      if (attempt >= attempts || !NAV_RACE.test(String(error))) throw error;
      console.log(`[retry] navigation race on attempt ${attempt} (${String(error).slice(0, 90)})`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Evaluate with retry; a dead page is reloaded before the next attempt. */
async function evaluateResilient(page, fn, arg, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      if (attempt >= retries) throw error;
      console.log(`[retry] evaluate attempt ${attempt} failed (${String(error).slice(0, 120)}) — reloading page`);
      errors.push(String(error));
      await gotoResilient(page);
    }
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(300_000);
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
    else if (msg.type() === "log" && msg.text().startsWith("[audit] ")) console.log(msg.text().slice(8));
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await gotoResilient(page);

  // Phase 0: fixtures (bank + signal + base render), cached on window.
  const basePeak = await evaluateResilient(page, async () => {
    const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
    const p = await mod.auditSetup();
    return p;
  });
  console.log(`[audit] base render peak=${basePeak.toFixed(3)}`);

  /**
   * Recycle the page every RECYCLE_EVERY measured plugins.
   *
   * Not a product leak: measured 2026-10-18, 40 consecutive `renderProject`
   * calls in one page hold the JS heap flat at 54 MB while contexts accumulate
   * (859 -> 908), and a canary oscillator keeps allocating the whole way. The
   * render path releases everything it owns. What fails is the browser's own
   * native audio budget, and it only fails after an hour: a full run logged
   * `NotSupportedError: ... createOscillator ... insufficient memory` from
   * `noteOn` in src/instruments/registry.ts near the very end.
   *
   * There is no way to close the contexts deterministically — this Chromium
   * exposes no `close()` on OfflineAudioContext or BaseAudioContext at all
   * (measured), so they can only leave via GC. Recycling the page is therefore
   * the only lever, and it is safe: the fixtures live on `window` by design and
   * rebuild themselves on the next evaluate.
   *
   * Cost check before setting this too low: `generateFactoryBank()` synthesises
   * its fallback samples with ~850 offline contexts, so every reload pays that
   * again. 20 keeps that to a handful of rebuilds for a full run.
   */
  const recycleEvery = Math.max(1, Number(process.env.KYX_AUDIT_RECYCLE_EVERY) || 20);
  let sinceRecycle = 0;
  const recycleIfDue = async () => {
    sinceRecycle += 1;
    if (sinceRecycle < recycleEvery) return;
    console.log(`[audit] recycling page after ${sinceRecycle} plugins (native audio budget)`);
    sinceRecycle = 0;
    await gotoResilient(page);
  };

  // Phase 1: effects, one evaluate each (or the KYX_AUDIT_ONLY subset).
  const effectTypes = await page.evaluate(async () => {
    const reg = await import("/src/effects/registry.ts");
    return reg.EFFECT_ORDER;
  });
  const wantedEffects =
    onlyEffects.length > 0 || onlyInstruments.length > 0
      ? effectTypes.filter((t) => onlyEffects.includes(t))
      : effectTypes.filter((t) => !report.effects.some((e) => e.type === t));
  for (const type of wantedEffects) {
    console.log(`[audit] effect ${type}`);
    try {
      const result = await evaluateResilient(
        page,
        async (t) => {
          const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
          return mod.auditOneEffect(t);
        },
        type,
      );
      const existing = report.effects.findIndex((e) => e.type === type);
      if (existing >= 0) report.effects[existing] = result;
      else report.effects.push(result);
    } catch (error) {
      console.log(`[audit] FAIL effect ${type}: ${String(error).slice(0, 200)}`);
      errors.push(`effect ${type}: ${String(error)}`);
      report.effects.push({
        type,
        sweepError: `runner: ${String(error).slice(0, 200)}`,
        defaultPeak: 0,
        defaultFinite: false,
        bypassDelta: 0,
        params: [],
        deadParams: [],
        unstableParams: [],
        rapidSwingFinite: false,
        presetsFinite: 0,
        presetsTotal: 0,
        hostError: "not reached",
        hostProcesses: false,
        hostDelta: 0,
        hostBypassEqualsRemoved: false,
        hostFinite: false,
        automationDelta: 0,
        automationFinite: false,
        restoreMaxDiff: Number.POSITIVE_INFINITY,
        name: type,
        category: "unknown",
      });
    }
    saveReport();
    await recycleIfDue();
  }

  // Phase 2: instruments, one evaluate each.
  const instrumentKinds = await page.evaluate(async () => {
    const reg = await import("/src/instruments/registry.ts");
    return reg.INSTRUMENT_ORDER;
  });
  const wantedInstruments =
    onlyInstruments.length > 0
      ? instrumentKinds.filter((k) => onlyInstruments.includes(k))
      : onlyEffects.length > 0
        ? []
        : instrumentKinds.filter((k) => !report.instruments.some((i) => i.kind === k));
  for (const kind of wantedInstruments) {
    console.log(`[audit] instrument ${kind}`);
    try {
      const result = await evaluateResilient(
        page,
        async (k) => {
          const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
          return mod.auditOneInstrument(k);
        },
        kind,
      );
      const existing = report.instruments.findIndex((i) => i.kind === kind);
      if (existing >= 0) report.instruments[existing] = result;
      else report.instruments.push(result);
    } catch (error) {
      console.log(`[audit] FAIL instrument ${kind}: ${String(error).slice(0, 200)}`);
      errors.push(`instrument ${kind}: ${String(error)}`);
      report.instruments.push({
        kind,
        name: kind,
        defaultAudible: false,
        defaultPeak: 0,
        unstableParams: [`runner: ${String(error).slice(0, 160)}`],
        deadParams: [],
        wiredParams: 0,
        totalParams: 0,
      });
    }
    saveReport();
    await recycleIfDue();
  }

  // Phase 3: interactions.
  if (onlyEffects.length === 0 && onlyInstruments.length === 0 && !report.interactions) {
    console.log("[audit] interactions");
    try {
      report.interactions = await evaluateResilient(page, async () => {
        const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
        return mod.auditInteractionsPhase();
      });
    } catch (error) {
      errors.push(`interactions: ${String(error)}`);
      report.interactions = {
        chainFinite: false,
        chainPeak: 0,
        chainRestoreDiff: Number.POSITIVE_INFINITY,
        duplicateDelta: 0,
        duplicateFinite: false,
        liveInsertRemoveClean: false,
        rapidSyncsClean: false,
        notes: [`runner: ${String(error).slice(0, 200)}`],
      };
    }
    saveReport();
  }

  report.finishedAt = new Date().toISOString();
  saveReport();
  console.log(`[audit] report written to ${outPath}`);

  /**
   * Gate semantics live in scripts/lib/plugin-audit-gate.mjs so they can be
   * exercised against an existing report without a multi-hour re-render. The
   * short version: a failed measurement or a measured health violation fails;
   * dead parameters and console noise do not. A gate that is red on arrival
   * (143 dead parameters exist today) or red because the harness disabled its
   * own HMR socket teaches people to ignore it.
   */
  const gate = evaluateAuditGate(report);
  if (saveFailures > 0) {
    gate.failures.push(`report could not be persisted in ${saveFailures} of the save attempts`);
    gate.ok = false;
  }

  console.log(
    `[audit] ${gate.stats.effects} effects, ${gate.stats.instruments} instruments, ${gate.stats.deadParameters} dead parameters, ${gate.stats.notProcessing.length} effects not processing in the host graph`,
  );
  // Gated parameters are NOT dead: they measured as inert only because a
  // sibling switch was off. Reported apart from the dead count so the two
  // never get added together.
  if (gate.stats.gatedParameters > 0) {
    console.log(
      `[audit]   ${gate.stats.gatedParameters} parameters gated behind a sibling switch (not dead): ${gate.stats.gatedByEffect.map((e) => `${e.type}(${e.gated})`).join(", ")}`,
    );
  }
  if (gate.stats.notProcessing.length > 0)
    console.log(`[audit]   not processing: ${gate.stats.notProcessing.join(", ")}`);
  // Reported apart from the line above on purpose: a zero host delta with a
  // documented reason is the fixture being unable to excite the plugin, while a
  // zero delta without one is an unexplained hole. Printing both as "not
  // processing" hid that difference in every run so far.
  if (gate.stats.hostExempt.length > 0)
    console.log(
      `[audit]   exempt from host test (zero delta is correct): ${gate.stats.hostExempt.map((e) => e.type).join(", ")}`,
    );
  if (gate.stats.silentInstruments.length > 0) {
    console.log(`[audit]   silent by default: ${gate.stats.silentInstruments.join(", ")}`);
  }

  if (errors.length > 0) {
    console.log(`[audit] ${errors.length} console/diagnostic message(s) — logged, not fatal:`);
    for (const e of [...new Set(errors)].slice(0, 10)) console.log(`  ~ ${e.slice(0, 240)}`);
  }
  if (!gate.ok) {
    console.log(`[audit] GATE FAILED — ${gate.failures.length} problem(s):`);
    for (const f of gate.failures.slice(0, 25)) console.log(`  ! ${f.slice(0, 300)}`);
    process.exitCode = 1;
  } else {
    console.log(`[audit] GATE PASSED — every measured effect processed and stayed finite`);
  }
} finally {
  await browser?.close();
  await server.close();
}
