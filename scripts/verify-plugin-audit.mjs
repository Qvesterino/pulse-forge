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
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5221;

const only = (process.env.KYX_AUDIT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const outPath = path.join(
  root,
  "docs",
  only.length > 0 ? `plugin-audit-2026-09-27-${only.join("_")}.report.json` : "plugin-audit-2026-09-27.report.json",
);

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

// Resume support: an existing report's healthy rows are kept and skipped —
// only missing rows and rows carrying runner/sweep errors are re-rendered.
let report = {
  effects: [],
  instruments: [],
  interactions: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
};
if (fs.existsSync(outPath)) {
  try {
    const prior = JSON.parse(fs.readFileSync(outPath, "utf8"));
    report.startedAt = prior.startedAt ?? report.startedAt;
    report.effects = (prior.effects ?? []).filter((e) => !e.sweepError && !e.hostError && e.hostFinite);
    report.instruments = (prior.instruments ?? []).filter(
      (i) => i.defaultAudible && !(i.unstableParams ?? []).some((u) => String(u).startsWith("runner:")),
    );
    report.interactions = prior.interactions && prior.interactions.chainRestoreDiff != null ? prior.interactions : null;
    console.log(`[resume] keeping ${report.effects.length} effect rows, ${report.instruments.length} instrument rows`);
  } catch {
    console.log("[resume] existing report unreadable — starting fresh");
  }
}
const errors = [];

function saveReport() {
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
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
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
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

  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
      break;
    } catch (error) {
      if (attempt >= 3 || !/interrupted|context was destroyed|navigation|timeout/i.test(String(error))) throw error;
      console.log("[retry] navigation race — retrying goto");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Phase 0: fixtures (bank + signal + base render), cached on window.
  const basePeak = await evaluateResilient(page, async () => {
    const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
    const p = await mod.auditSetup();
    return p;
  });
  console.log(`[audit] base render peak=${basePeak.toFixed(3)}`);

  // Phase 1: effects, one evaluate each (or the KYX_AUDIT_ONLY subset).
  const effectTypes = await page.evaluate(async () => {
    const reg = await import("/src/effects/registry.ts");
    return reg.EFFECT_ORDER;
  });
  const wantedEffects =
    only.length > 0
      ? effectTypes.filter((t) => only.includes(t))
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
  }

  // Phase 2: instruments, one evaluate each.
  const instrumentKinds = await page.evaluate(async () => {
    const reg = await import("/src/instruments/registry.ts");
    return reg.INSTRUMENT_ORDER;
  });
  const wantedInstruments =
    only.length > 0 ? [] : instrumentKinds.filter((k) => !report.instruments.some((i) => i.kind === k));
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
  }

  // Phase 3: interactions.
  if (only.length === 0 && !report.interactions) {
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

  if (errors.length > 0) {
    console.log(`[audit] ${errors.length} error(s) during the audit:`);
    for (const e of errors.slice(0, 20)) console.log(`  ! ${e.slice(0, 300)}`);
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await server.close();
}
