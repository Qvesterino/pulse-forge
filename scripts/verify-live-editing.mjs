/**
 * LIVE EDITING VERIFIER — edit-the-timeline-while-it-plays, verified by EAR.
 *
 * Boots a vite dev server in-process (same pattern as verify-factory-presets),
 * opens the page in headless Chromium, and runs the in-page live-editing pass
 * (src/browser-checks-live-editing.ts): realtime engine + transport +
 * scheduler, one editing gesture per scenario during playback, master-tap
 * recordings analysed for ghost audio / missing resumes / continuity.
 *
 * Env overrides: PORT (default 5223), NAV_TIMEOUT_MS, KYX_BROWSER_ENGINE
 * (chromium/firefox/webkit), KYX_BROWSER_EXECUTABLE_PATH.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT) || 5223;
const navTimeout = Number(process.env.NAV_TIMEOUT_MS) || 120_000;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const launchOptions = { headless: true };
if (process.env.KYX_BROWSER_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.KYX_BROWSER_EXECUTABLE_PATH;
}
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();

const errors = [];
const streamed = [];
page.on("console", (msg) => {
  if (msg.type() !== "error" && msg.text().startsWith("[live-edit] ")) {
    try {
      streamed.push(JSON.parse(msg.text().slice("[live-edit] ".length)));
    } catch {
      streamed.push(msg.text());
    }
  } else if (msg.type() === "error") {
    errors.push(msg.text());
  }
});
page.on("pageerror", (err) => errors.push(String(err)));

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: navTimeout });
  const run = () =>
    page.evaluate(async () => {
      const mod = await import("/src/browser-checks-live-editing.ts");
      return mod.runLiveEditingChecks((message) => console.log(`[live-edit] ${JSON.stringify(message)}`));
    });
  let results;
  try {
    results = await run();
  } catch (error) {
    // Vite full-reload races can destroy the context mid-evaluate — retry once.
    if (!/context was destroyed|navigation/i.test(String(error))) throw error;
    await new Promise((r) => setTimeout(r, 1500));
    results = await run();
  }

  console.log("");
  for (const line of streamed) console.log(line);
  console.log("");
  let failed = 0;
  for (const result of results) {
    console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.name}`);
    console.log(`        ${result.message}`);
    if (!result.ok) failed += 1;
  }
  const audioErrors = errors.filter((e) => !/AudioContext|autoplay|user gesture/i.test(e));
  if (audioErrors.length > 0) {
    console.log("");
    console.log(`Console/page errors during pass (${audioErrors.length}):`);
    for (const e of audioErrors.slice(0, 10)) console.log(`  - ${e.slice(0, 300)}`);
  }
  exitCode = failed === 0 && audioErrors.length === 0 ? 0 : 1;
  console.log("");
  console.log(
    `${results.length - failed}/${results.length} live-editing checks passed` +
      (audioErrors.length ? `, ${audioErrors.length} console error(s)` : ""),
  );
} catch (error) {
  console.error(`[live-editing] harness error: ${error}`);
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
process.exitCode = exitCode;
