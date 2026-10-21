/**
 * TEMPORARY PROBE v4 — WHY does the render differ between two renders of the
 * same document?
 *
 * MEASURED so far:
 *  - v1: two renders of the same doc + same bank in the same page are NOT
 *    bit-identical → the variance is in the renderer, not in the curated layer
 *    (129 loaded, 0 failed, 17 skipped — the same every time) and not in the
 *    bank.
 *  - v2: pinning Math.random and Date.now made the rms of two renders match
 *    to 9 decimals, but the checksum still differed.
 *
 * This probe renders SEVEN times in a row and reports, for each render: the
 * buffer length, the audit's own metrics, a checksum, and the bank's content
 * REVISION (a monotonic counter the bank bumps whenever a sample is added or
 * replaced). If the revision moves between renders, something is still landing
 * in the bank mid-render. If the length moves, the render window moved.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5294;

const server = await createServer({
  root,
  logLevel: "error",
  optimizeDeps: { entries: ["index.html"] },
  server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
const requests = [];
page.on("request", (r) => {
  const url = r.url();
  if (url.includes("/samples/")) requests.push(url.split("/samples/")[1]);
});
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
  const afterBank = bank.revision;
  const curated = await loadCuratedLayer(bank);
  const afterCurated = bank.revision;

  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (drum) drum.effects = [];
  const opts = { mode: "pattern", sampleRate: SR, tailSeconds: 0.6, masterProcessing: false };

  const renders = [];
  for (let i = 0; i < 7; i++) {
    const buf = await renderProject(doc, bank, opts);
    const m = checks.metricsOf(buf);
    renders.push({
      i,
      frames: buf.length,
      rms: +m.rms.toFixed(9),
      peak: +m.peak.toFixed(9),
      side: +m.side.toFixed(9),
      checksum: checksum(buf),
      bankRevision: bank.revision,
    });
  }

  return {
    afterBank,
    afterCurated,
    curated: { loaded: curated.loaded, failed: curated.failed.length, skipped: curated.skipped.length },
    renders,
  };
});

console.log(JSON.stringify(out, null, 1));
console.log("sample requests seen by the page:", requests.length);

await browser.close();
await server.close();
