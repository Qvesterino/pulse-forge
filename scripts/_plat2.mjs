import { createServer } from "vite";
import { chromium } from "playwright";
const PORT = 5333;
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
await page.goto(`http://127.0.0.1:${PORT}/__probe_blank`, { waitUntil: "commit" });
// Warm the page first (one throwaway generation) so we measure the warm path
const out = await page.evaluate(async ([PORT]) => {
  const bankF = await import(`/src/sample-library/factory.ts?bust=${Date.now()}`);
  const bank = await bankF.generateFactoryBank();
  const templates = await import("/src/project-model/templates.ts");
  const normalize = await import("/src/intent/normalize.ts");
  const pipeline = await import("/src/intent/pipeline.ts");
  const doc = templates.createProjectFromTemplate("house");
  const mkIntent = () => normalize.normalizeIntent({
    genre: "techno", seed: "latency-probe", roles: ["drums", "bass"],
    candidateCount: 4, symbolicCandidates: 2, length: 16,
  });
  // cold run (JIT/worklet warmup) — discarded
  const coldMs = Math.round((await (async () => { const t = performance.now(); await pipeline.generateAsyncResult(doc, mkIntent(), { mode: "apply", includeBank: true }); return performance.now() - t; })()));
  // 3 warm runs — the number users experience
  const warm = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await pipeline.generateAsyncResult(doc, mkIntent(), { mode: "apply", includeBank: true });
    warm.push(Math.round(performance.now() - t));
  }
  return { coldMs, warm };
}, [PORT]);
console.log(JSON.stringify(out));
await browser.close();
await server.close();
