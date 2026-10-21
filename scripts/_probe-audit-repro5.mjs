/**
 * TEMPORARY PROBE v5 — the id consumption profile.
 *
 * MEASURED so far:
 *  - v1: two renders of the same doc + same bank in the SAME page are not
 *    bit-identical → the variance is in the renderer.
 *  - v3: with the repo's deterministic-id mode on (counter reset before each
 *    render) the render metric spread falls from 3.7e-6 to 3.1e-11 — five
 *    orders of magnitude below the audit's threshold. The random id is the
 *    main cause of the drift.
 *
 * Before the fix can be written, three things have to be known:
 *   1. how many ids the TEMPLATE creation consumes (the doc's ids must be
 *      deterministic too, or a sort keyed by them stays random)
 *   2. how many ids ONE RENDER consumes (the counter has to be reset past the
 *      template's allocation, or a render id collides with a doc id)
 *   3. whether the doc's ids are identical across two creations
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5295;

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
  const [{ generateFactoryBank }, { loadCuratedLayer }, { createProjectFromTemplate }, { renderProject }, ids] =
    await Promise.all([
      import("/src/sample-library/factory.ts"),
      import("/src/sample-library/curated.ts"),
      import("/src/project-model/templates.ts"),
      import("/src/rendering/renderer.ts"),
      import("/src/shared/ids.ts"),
    ]);

  const restore = ids.useDeterministicIds();

  // 1. How many ids does the template creation consume?
  ids.resetDeterministicIds(0);
  const docA = createProjectFromTemplate("house");
  const afterTemplateA = ids.uid("PROBE");

  // 3. Is the doc deterministic across two creations?
  ids.resetDeterministicIds(0);
  const docB = createProjectFromTemplate("house");
  const afterTemplateB = ids.uid("PROBE");

  const idOf = (doc) => ({
    tracks: doc.tracks.map((t) => t.id),
    patterns: doc.patterns.map((p) => p.id),
    activePattern: doc.activePatternId,
  });

  const bank = await generateFactoryBank();
  await loadCuratedLayer(bank);
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (drum) drum.effects = [];
  const opts = { mode: "pattern", sampleRate: SR, tailSeconds: 0.6, masterProcessing: false };

  // 2. How many ids does ONE render consume?
  ids.resetDeterministicIds(0);
  await renderProject(doc, bank, opts);
  const afterRender = ids.uid("PROBE");

  restore();

  return {
    templateIds: idOf(docA),
    templateIdsSecondRun: idOf(docB),
    templateDeterministic: JSON.stringify(idOf(docA)) === JSON.stringify(idOf(docB)),
    afterTemplateA,
    afterTemplateB,
    afterRender,
  };
});

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
