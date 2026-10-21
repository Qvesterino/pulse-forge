/**
 * TEMPORARY PROBE v7 — is the DOCUMENT's random id the run-to-run variance?
 *
 * MEASURED so far:
 *  - v1: two renders of the same doc + same bank in the same page are not
 *    bit-identical.
 *  - v4: SEVEN renders in one page — identical length, identical rms/peak/side
 *    to 9 decimals, stable bank revision, but a different checksum each time.
 *    So the bit-level drift is below the metrics' resolution.
 *  - v5: the render allocates NO ids; the TEMPLATE allocates ~35 of them, and
 *    with the deterministic-id mode on they are identical across creations.
 *  - v6: the render calls no Math.random, no Date.now, no crypto.randomUUID.
 *
 * ⇒ The run-to-run variance has to come from the DOCUMENT: the house template
 * mints a fresh random id for every track, pattern and NOTE, and the render
 * orders work by those ids somewhere. Two runs = two id sets = two orderings.
 *
 * This probe renders:
 *   A) the same doc twice        (control — expect stable)
 *   B) two DIFFERENT docs (fresh template each, so different ids) — if the
 *      metrics move here and not in A, the document's ids are the cause.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5298;

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
  await loadCuratedLayer(bank);
  const opts = { mode: "pattern", sampleRate: SR, tailSeconds: 0.6, masterProcessing: false };

  const makeDoc = () => {
    const doc = createProjectFromTemplate("house");
    const drum = doc.tracks.find((t) => t.kind === "drum");
    if (drum) drum.effects = [];
    return doc;
  };
  const render = async (doc) => {
    const buf = await renderProject(doc, bank, opts);
    const m = checks.metricsOf(buf);
    return { checksum: checksum(buf), rms: +m.rms.toFixed(9), peak: +m.peak.toFixed(9), side: +m.side.toFixed(9) };
  };

  // A) the same document twice (control)
  const docA = makeDoc();
  const a1 = await render(docA);
  const a2 = await render(docA);

  // B) two different documents — the template mints fresh random ids each time
  const docB = makeDoc();
  const docC = makeDoc();
  const b1 = await render(docB);
  const b2 = await render(docC);

  // C) two different documents with DETERMINISTIC ids
  const restore = ids.useDeterministicIds();
  ids.resetDeterministicIds(0);
  const docD = makeDoc();
  ids.resetDeterministicIds(0);
  const docE = makeDoc();
  const c1 = await render(docD);
  const c2 = await render(docE);
  restore();

  const spread = (x, y) => ({
    rms: +(y.rms - x.rms).toExponential(3),
    peak: +(y.peak - x.peak).toExponential(3),
    side: +(y.side - x.side).toExponential(3),
  });

  return {
    sameDoc: { first: a1, second: a2, spread: spread(a1, a2) },
    differentDocs: { first: b1, second: b2, spread: spread(b1, b2) },
    differentDocsDeterministicIds: { first: c1, second: c2, spread: spread(c1, c2) },
    ids: {
      docB: docB.tracks.map((t) => t.id),
      docC: docC.tracks.map((t) => t.id),
      docD: docD.tracks.map((t) => t.id),
      docE: docE.tracks.map((t) => t.id),
    },
  };
});

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
