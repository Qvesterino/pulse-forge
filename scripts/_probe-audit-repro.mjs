/**
 * TEMPORARY PROBE — is the render's non-determinism caused by random ids?
 *
 * MEASURED (probe v1): two renders of the SAME doc with the SAME bank in the
 * SAME page are not bit-identical. So the variance is in the renderer, not in
 * the curated layer or the bank.
 *
 * The suspect: `uid()` (src/shared/ids.ts) is
 *   Math.random().toString(36) + Date.now().toString(36)
 * so every node the engine creates gets a different id on every render. If
 * anything downstream orders work BY ID (a topological sort, a render order, a
 * PDC sync), the mix order changes — and floating-point addition is not
 * associative, so the sum differs in the last bits. The audit then measures a
 * DIFFERENCE between two nearly identical renders, and a near-cancellation
 * amplifies bit-level noise into visible percentages.
 *
 * This probe renders the same doc four times:
 *   1-2  with the random id source live   (expect: different)
 *   3-4  with Math.random and Date.now pinned (expect: identical, if the
 *        hypothesis is right)
 * and reports the AUDIT's own metrics for each pair, so the size of the
 * effect on the verdict is visible and not just the checksum.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5291;

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
  const [{ generateFactoryBank }, { loadCuratedLayer }, { createProjectFromTemplate }, { renderProject }, checks] =
    await Promise.all([
      import("/src/sample-library/factory.ts"),
      import("/src/sample-library/curated.ts"),
      import("/src/project-model/templates.ts"),
      import("/src/rendering/renderer.ts"),
      import("/src/plugin-audit-checks.ts"),
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

  // 1-2: the id source as it ships.
  const a = await render();
  const b = await render();

  // 3-4: the id source pinned.
  const realRandom = Math.random;
  const realNow = Date.now;
  let n = 0;
  Math.random = () => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return n / 4294967296;
  };
  let clock = 1700000000000;
  Date.now = () => (clock += 1);
  const c = await render();
  const d = await render();
  Math.random = realRandom;
  Date.now = realNow;

  const pick = (m) => ({
    checksum: m.checksum,
    rms: +m.metrics.rms.toFixed(9),
    peak: +m.metrics.peak.toFixed(9),
    side: +m.metrics.side.toFixed(9),
  });

  return {
    curated: { loaded: curated.loaded, failed: curated.failed.length, skipped: curated.skipped.length },
    live: { first: pick(a), second: pick(b), identical: a.checksum === b.checksum },
    pinned: { first: pick(c), second: pick(d), identical: c.checksum === d.checksum },
  };
});

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
