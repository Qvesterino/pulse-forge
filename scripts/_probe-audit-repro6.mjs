/**
 * TEMPORARY PROBE v6 — WHO calls the non-deterministic sources during a render?
 *
 * Every hypothesis so far has been falsified or contradicted by the numbers:
 *  - the curated layer is identical every run (129 loaded, 0 failed, 17 skipped)
 *  - pinning Math.random/Date.now stabilised the rms, but uid() prefers
 *    crypto.randomUUID, which the patch did not touch
 *  - the deterministic-id mode also stabilised it (3.7e-6 -> 3.1e-11)
 *
 * So: stop guessing. Wrap every non-deterministic source, render once, and
 * print the call stacks. The stack names the module.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5296;

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
  const [{ generateFactoryBank }, { loadCuratedLayer }, { createProjectFromTemplate }, { renderProject }] =
    await Promise.all([
      import("/src/sample-library/factory.ts"),
      import("/src/sample-library/curated.ts"),
      import("/src/project-model/templates.ts"),
      import("/src/rendering/renderer.ts"),
    ]);

  const bank = await generateFactoryBank();
  await loadCuratedLayer(bank);
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (drum) drum.effects = [];

  // --- instrument every non-deterministic source -----------------------------
  const hits = { random: [], now: [], uuid: [] };
  const keep = (bucket, stack) => {
    const line = (stack || "")
      .split("\n")
      .slice(1, 6)
      .map((l) => l.trim())
      .join(" | ");
    if (line && !hits[bucket].includes(line)) hits[bucket].push(line);
  };

  const realRandom = Math.random;
  Math.random = function () {
    keep("random", new Error().stack);
    return realRandom();
  };
  const realNow = Date.now;
  Date.now = function () {
    keep("now", new Error().stack);
    return realNow();
  };
  const realUuid = crypto.randomUUID?.bind(crypto);
  if (realUuid) {
    crypto.randomUUID = function () {
      keep("uuid", new Error().stack);
      return realUuid();
    };
  }

  const opts = { mode: "pattern", sampleRate: SR, tailSeconds: 0.6, masterProcessing: false };
  await renderProject(doc, bank, opts);

  Math.random = realRandom;
  Date.now = realNow;
  if (realUuid) crypto.randomUUID = realUuid;

  return hits;
});

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
