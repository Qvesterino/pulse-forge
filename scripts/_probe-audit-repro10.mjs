/**
 * TEMPORARY PROBE v10 — the residual floor, measured on the audit's OWN
 * fixture.
 *
 * Probe v9 (two factory banks) timed out on this loaded machine, so this one
 * reuses the audit's state instead of building a second bank:
 * `auditSetup()` puts the bank and the base document on
 * `window.__kyxPluginAuditState`.
 *
 * Question: the same document + the same bank, rendered TWICE in the same
 * process — how far apart are the samples? That number is the floor the
 * audit's metrics sit on, and it is the honest answer to "are the remaining
 * 1e-8 differences the engine's float noise, or a second variability source
 * that is still fixable?"
 *
 *   node scripts/_probe-audit-repro10.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5300;

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

const out = await page.evaluate(async () => {
  const SR = 44100;
  const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
  const renderer = await import(`/src/rendering/renderer.ts?bust=${Date.now()}`);

  await mod.auditSetup();
  const state = window.__kyxPluginAuditState;

  const render = () =>
    renderer.renderProject(state.baseDoc, state.bank, {
      mode: "pattern",
      sampleRate: SR,
      tailSeconds: 0.6,
      masterProcessing: false,
    });

  const diff = (a, b) => {
    let max = 0;
    let firstAt = -1;
    let differing = 0;
    let sumSq = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > 0) {
        differing++;
        if (firstAt < 0) firstAt = i;
      }
      if (d > max) max = d;
      sumSq += d * d;
    }
    return { max, firstAt, differing, rms: Math.sqrt(sumSq / Math.max(1, a.length)) };
  };

  const rms = (d) => {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, d.length));
  };

  const r1 = await render();
  const r2 = await render();
  const r3 = await render();

  const a1 = r1.getChannelData(0);
  const a2 = r2.getChannelData(0);
  const a3 = r3.getChannelData(0);

  // The document's own ids — the thing the fix made deterministic.
  const docIds = state.baseDoc.tracks.map((t) => t.id);

  return {
    frames: r1.length,
    channels: r1.numberOfChannels,
    signalRms: rms(a1),
    signalPeak: Math.max(...Array.from(a1).map(Math.abs)),
    docIds,
    render12: diff(a1, a2),
    render23: diff(a2, a3),
    rmsRel12: Math.abs(rms(a1) - rms(a2)) / Math.max(1e-30, rms(a1)),
    rmsRel13: Math.abs(rms(a1) - rms(a3)) / Math.max(1e-30, rms(a1)),
    // How big is the difference compared to one float32 step at this level?
    float32EpsAtPeak: Math.max(...Array.from(a1).map(Math.abs)) * 1.1920929e-7,
  };
});

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
