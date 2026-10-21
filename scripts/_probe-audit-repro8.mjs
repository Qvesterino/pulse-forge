/**
 * TEMPORARY PROBE v8 — the audit's own numbers, across two PROCESSES.
 *
 * MEASURED (v7): the house template mints a fresh random id for every track,
 * pattern and note, and the render's ordering depends on those ids. Two
 * templates with random ids render with an rms spread of 7.1e-6 and a peak
 * spread of 1.2e-4; two templates with deterministic ids render BIT-IDENTICALLY.
 * The audit's relative deltas amplify that into percent-level movement in the
 * report (pitchCorrect 0.254 -> 0.144, apeks 5.658 -> 6.638 between two runs).
 *
 * This probe runs the audit's OWN entry point (auditOneEffect) and prints the
 * numbers the report carries. Run it twice, in two processes, and compare:
 * the numbers must be identical for the audit to have a baseline worth
 * comparing.
 *
 *   node scripts/_probe-audit-repro8.mjs        # run 1
 *   node scripts/_probe-audit-repro8.mjs        # run 2
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5299;
const TYPES = (process.env.PROBE_TYPES ?? "sirka,eq,pitchCorrect").split(",");

const server = await createServer({
  root,
  logLevel: "error",
  optimizeDeps: { entries: ["index.html"] },
  server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/bench-stem.html`, { waitUntil: "domcontentloaded", timeout: 600000 });

const out = await page.evaluate(async (types) => {
  const rows = [];
  for (const type of types) {
    const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
    const e = await mod.auditOneEffect(type);
    rows.push({
      type: e.type,
      hostProcesses: e.hostProcesses,
      hostDelta: e.hostDelta,
      hostMixDelta: e.hostMixDelta,
      automationDelta: e.automationDelta,
      hostMaterial: e.hostMaterial,
      hostState: e.hostState,
      deadParams: e.deadParams,
      gatedParams: e.gatedParams,
    });
  }
  return rows;
}, TYPES);

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
