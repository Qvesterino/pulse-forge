import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5221;
const server = await createServer({
  root,
  logLevel: "error",
  server: { port, host: "127.0.0.1", strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const result = await page.evaluate(async () => {
    const [{ generateFactoryBank }, { auditFactoryPresetAudio }, { loadCuratedLayer }] = await Promise.all([
      import("/src/sample-library/factory.ts"),
      import("/src/browser-checks.ts"),
      import("/src/sample-library/curated.ts"),
    ]);
    // Measure the bank the app actually plays (runChecks parity): sampler/
    // texture probes hit curated overrides, so the synth-only bank would
    // false-positive drift against the curated-based loudness map.
    const bank = await generateFactoryBank();
    await loadCuratedLayer(bank);
    return auditFactoryPresetAudio(bank);
  });
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${result.name} — ${result.message}`);
  if (!result.ok) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
