/**
 * Internal plugin functional audit — real-audio evidence runner.
 *
 * Boots a Vite dev server, opens a real browser page, and executes
 * src/plugin-audit-checks.ts runPluginAudit() inside the page (the same
 * pattern as scripts/verify-browser.mjs). Writes the measured report to
 * docs/plugin-audit-2026-09-27.report.json for the matrix generator.
 *
 * Usage: node scripts/verify-plugin-audit.mjs [--port 5221]
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5221;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
    else if (msg.type() === "log" && msg.text().startsWith("[audit] ")) console.log(msg.text().slice(8));
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      break;
    } catch (error) {
      if (attempt >= 3 || !/interrupted|context was destroyed|navigation/i.test(String(error))) throw error;
      console.log("[retry] navigation race — retrying goto");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const only = (process.env.KYX_AUDIT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let report = null;
  for (let attempt = 1; attempt <= 3 && !report; attempt++) {
    try {
      const onlyArg = JSON.stringify(only);
      report = await page.evaluate(async (onlyTypes) => {
        const mod = await import("/src/plugin-audit-checks.ts");
        return mod.runPluginAudit((msg) => console.log(`[audit] ${msg}`), onlyTypes);
      }, onlyArg);
    } catch (error) {
      if (attempt === 3 || !/context was destroyed|navigation/i.test(String(error))) throw error;
      console.log("[retry] page reload race — retrying evaluate");
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    }
  }

  const suffix = only.length > 0 ? `-${only.join("_")}` : "";
  const outPath = path.join(root, "docs", `plugin-audit-2026-09-27${suffix}.report.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[audit] report written to ${outPath}`);

  // Console errors during the audit are findings, not noise — flag them.
  if (errors.length > 0) {
    console.log(`[audit] ${errors.length} console error(s) during the audit:`);
    for (const e of errors.slice(0, 20)) console.log(`  ! ${e.slice(0, 300)}`);
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await server.close();
}
