/**
 * TEMPORARY PROBE v3 — does the deterministic-id mode make the render stable?
 *
 * MEASURED (v1): two renders of the SAME doc with the SAME bank in the SAME
 * page are not bit-identical → the variance is in the renderer.
 *
 * The suspect: `uid()` (src/shared/ids.ts) returns `prefix-${crypto.randomUUID()}`
 * → every node the engine creates gets a different id on every render. If
 * anything downstream orders work BY ID, the mix order changes — and float
 * addition is not associative, so the sum differs in the last bits. The audit
 * then measures a DIFFERENCE between two nearly identical renders, and a
 * near-cancellation amplifies bit-level noise into visible percentages.
 *
 * The repo already HAS the mechanism for this: `useDeterministicIds()` +
 * `resetDeterministicIds()` in src/shared/ids.ts — test-only today, but it is
 * exactly what the audit needs.
 *
 * This probe renders the same doc four times and reports the AUDIT's own
 * metrics for each, so the effect on the verdict is visible, not just a
 * checksum:
 *   1-2  ids as they ship          (expect: different)
 *   3-4  deterministic ids on      (expect: identical, if the hypothesis holds)
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5293;

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
  const [{ generateFactoryBank }, { loadCuratedLayer }, { createProjectFromTemplate }, { renderProject }, checks, ids] =
    await Promise.all([
      import("/src/sample-library/factory.ts"),
      import("/src/sample-library/curated.ts"),
      import("/src/project-model/templates.ts"),
      import("/src/rendering/renderer.ts"),
      import("/src/plugin-audit-checks.ts"),
      import("/src/shared/ids.ts"),
    ]);

  const checksum = (buffer) => {
    let h = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) h = (Math.imul(h ^ (d[i] * 4294967296), 16777619) >>> 0) | 0;
    }
    return h;
  };

  const bank = await generateFactoryBank();
  const curated = await loadCuratedLayer(bank);
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (drum) drum.effects = [];
  const opts = { mode: "pattern", sampleRate: SR, tailSeconds: 0.6, masterProcessing: false };

  const render = async () => {
    const buf = await renderProject(doc, bank, opts);
    return { checksum: checksum(buf), metrics: checks.metricsOf(buf) };
  };

  const a = await render();
  const b = await render();

  // The repo's own deterministic-id mode. The counter is reset before EVERY
  // render: the audit renders the same document many times, and each render
  // has to get the SAME ids in the same order — a monotonic counter would give
  // every render different ids, which is exactly the variance under test.
  const restore = ids.useDeterministicIds();
  ids.resetDeterministicIds(0);
  const c = await render();
  ids.resetDeterministicIds(0);
  const d = await render();
  ids.resetDeterministicIds(0);
  const e = await render();
  restore();

  const pick = (m) => ({
    checksum: m.checksum,
    rms: +m.metrics.rms.toFixed(9),
    peak: +m.metrics.peak.toFixed(9),
    side: +m.metrics.side.toFixed(9),
  });

  // The metric spread the audit actually sees.
  const spread = (x, y) => ({
    rms: +(y.metrics.rms - x.metrics.rms).toExponential(3),
    peak: +(y.metrics.peak - x.metrics.peak).toExponential(3),
    side: +(y.metrics.side - x.metrics.side).toExponential(3),
  });

  return {
    curated: { loaded: curated.loaded, failed: curated.failed.length, skipped: curated.skipped.length },
    live: { first: pick(a), second: pick(b), identical: a.checksum === b.checksum, metricSpread: spread(a, b) },
    deterministic: {
      first: pick(c),
      second: pick(d),
      third: pick(e),
      identical: c.checksum === d.checksum && d.checksum === e.checksum,
      metricSpread: spread(c, d),
    },
  };
});

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
