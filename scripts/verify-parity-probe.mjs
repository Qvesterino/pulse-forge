/**
 * Live↔offline parity DIAGNOSTIC probe (release-gate hardening).
 *
 * Boots the Vite dev server + headless Chromium and runs a small, VERBOSE
 * slice of the parity audit so a null-test failure can be diagnosed without
 * paying for the whole browser suite. For each case it prints:
 *
 *   liveNull    — the gated number (realtime capture vs offline render)
 *   controlNull — offline vs a SECOND offline render of the same doc
 *                 (determinism control: must be identical)
 *   peaks/rms   — signal sanity on both branches
 *   rates/frames— sample rate + length mismatches show up here
 *
 * Usage: node scripts/verify-parity-probe.mjs
 *        KYX_PARITY_CASES=bitcrusher,reverb node scripts/verify-parity-probe.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5341;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

let exitCode = 0;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(300_000);
  page.on("pageerror", (err) => console.error("[pageerror]", String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "log" && msg.text().startsWith("[parity]")) console.log(msg.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });

  const cases = (process.env.KYX_PARITY_CASES ?? "bitcrusher,eq,utility,reverb,compressor,limiter,kaskada")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const leadSec = Number(process.env.KYX_PARITY_LEAD ?? 0);
  // "reverb:mod=0" pins a single param for that type so a failure can be
  // bisected. Per-type, not global: a case WITHOUT a spec keeps defaults.
  const wanted = cases.map((c) => c.split(":")[0]);
  // Only ONE type may be pinned per run (the probe evaluates one spec per
  // case), so the override object is flat {param: value} and the runner
  // passes it to the case being evaluated.
  const overrideFor = Object.fromEntries(
    cases
      .map((c) => {
        const spec = c.split(":")[1];
        if (!spec) return null;
        const [key, value] = spec.split("=");
        const num = Number(value);
        return Number.isFinite(num) ? [key, num] : null;
      })
      .filter(Boolean),
  );

  // A shared dev machine means another agent's save triggers a Vite full
  // reload mid-evaluate; retry the whole evaluate on a context destroy.
  let out = null;
  for (let attempt = 1; attempt <= 4 && !out; attempt++) {
    try {
      out = await page.evaluate(
        async ({ wanted: types, lead, overrides }) => {
          const mod = await import("/src/testing/live-offline-parity.ts");
          const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
          const bank = await generateFactoryBank();
          const results = [];
          for (const type of types) {
            try {
              const m = await mod.__runParityCaseForProbe(bank, type, lead, overrides ?? {});
              results.push({ type, ...m });
            } catch (error) {
              results.push({ type, error: String(error) });
            }
          }
          return results;
        },
        { wanted, lead: leadSec, overrides: overrideFor },
      );
    } catch (error) {
      if (attempt === 4 || !/context was destroyed|navigation|interrupted/i.test(String(error))) throw error;
      console.log(`[retry] evaluate attempt ${attempt} lost its context - reloading page`);
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    }
  }

  for (const r of out) {
    if (r.error) {
      console.log(`${r.type}: ERROR ${r.error}`);
      continue;
    }
    console.log(
      [
        r.type.padEnd(12),
        `lead=${r.leadSec}`,
        `liveNull=${fmt(r.liveNullDb)}dB`,
        `corr=${fmt4(r.correlation)}`,
        `liveRepeat=${fmt(r.liveRepeatNullDb)}dB`,
        `control=${fmt(r.controlNullDb)}dB`,
        `rt-nondet=${r.realtimeNondeterministic}`,
        `offset=${r.alignOffset}`,
        `livePeak=${num(r.livePeak)} refPeak=${num(r.refPeak)}`,
        `frames live=${r.liveFrames}/ref=${r.refFrames}`,
      ].join("  "),
    );
  }
} catch (error) {
  console.error("[parity-probe] failed:", String(error));
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  process.exit(exitCode);
}

function fmt(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : "n/a";
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "n/a";
}
function fmt4(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "n/a";
}
