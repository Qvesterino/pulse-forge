import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 5203;
const server = await createServer({
  root,
  logLevel: "error",
  server: { port, host: "127.0.0.1", strictPort: true },
});
await server.listen();

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // The benchmark only needs a browser origin for Vite module imports. Do not
  // wait for the full studio boot or audio initialization here.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 30000 });

  const results = await page.evaluate(async () => {
    const { createDefaultProject } = await import("/src/project-model/schema.ts");
    const { generatePattern } = await import("/src/ai/generator.ts");
    const { AI_BASELINE_CASES, BASELINE_STEP_COUNTS, baselineOptions } = await import("/tests/fixtures/ai-baseline.ts");

    const measurements = [];
    for (const testCase of AI_BASELINE_CASES) {
      for (const stepCount of BASELINE_STEP_COUNTS) {
        const options = baselineOptions(testCase, stepCount);
        for (let i = 0; i < 5; i++) generatePattern(createDefaultProject(), options);

        const samples = [];
        for (let i = 0; i < 25; i++) {
          const start = performance.now();
          generatePattern(createDefaultProject(), options);
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
        measurements.push({
          caseId: testCase.id,
          stepCount,
          minMs: Number(samples[0].toFixed(3)),
          medianMs: Number(percentile(0.5).toFixed(3)),
          p95Ms: Number(percentile(0.95).toFixed(3)),
        });
      }
    }
    return measurements;
  });

  console.log(JSON.stringify({ runtime: "chromium", cases: results }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
