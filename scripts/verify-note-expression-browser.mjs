import { createServer } from "vite";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5221;
const server = await createServer({
  root,
  logLevel: "error",
  server: { port, host: "127.0.0.1", strictPort: true },
});

let browser;
let exitCode = 0;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit", timeout: 120_000 });
  const results = await page.evaluate(async () => {
    const { runNoteExpressionAudioChecks } = await import("/src/testing/noteExpressionAudioChecks.ts");
    return runNoteExpressionAudioChecks();
  });

  let failed = 0;
  for (const result of results) {
    console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.name} — ${result.message}`);
    if (!result.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} note-expression audio checks passed`);
  exitCode = failed > 0 ? 1 : 0;
} catch (error) {
  console.error("note-expression browser verification failed:", error);
  exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}

process.exitCode = exitCode;
