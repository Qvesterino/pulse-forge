/**
 * Bundle-size budget check. Run after `vite build` (wired into the build
 * script). Fails the build when the initial payload or the total shipped
 * JS grows beyond the budget — perf regressions must be a conscious
 * decision, not an accident.
 *
 * Budgets (raw, un-gzipped):
 *  - ENTRY (the chunk index.html boots with): the studio shell — engine,
 *    sequencer, project model. Everything else (yjs/collab, plugin panels,
 *    MP3 encoder, bottom dock panels, /embed, /gallery, /landing) is
 *    code-split and loads on demand.
 *  - TOTAL across all chunks: catches dead-weight creeping into the graph
 *    even when it is split.
 *
 * NOTE: the vendored AudioWorklet bundles (public/*-worklet.js, ~520 KB)
 * are NOT part of either budget — since the lazy loader they only download
 * when a project actually uses the plugin.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_BUDGET_KB = 975;
const TOTAL_BUDGET_KB = 2400;

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

const html = readFileSync(join(dist, "index.html"), "utf-8");
const entryMatch = /<script[^>]*src="(\/assets\/[^"]+\.js)"/.exec(html);
if (!entryMatch) {
  console.error("[size-budget] could not find the entry <script> in dist/index.html");
  process.exit(1);
}
const entryFile = join(dist, entryMatch[1].replace(/^\//, ""));

const entryKb = statSync(entryFile).size / 1024;
let totalKb = 0;
for (const file of readdirSync(join(dist, "assets"))) {
  if (file.endsWith(".js")) totalKb += statSync(join(dist, "assets", file)).size / 1024;
}

console.log(`[size-budget] entry: ${entryKb.toFixed(0)} KB (budget ${ENTRY_BUDGET_KB})`);
console.log(`[size-budget] total JS chunks: ${totalKb.toFixed(0)} KB (budget ${TOTAL_BUDGET_KB})`);

let failed = false;
if (entryKb > ENTRY_BUDGET_KB) {
  console.error(`[size-budget] FAIL — entry chunk over budget: ${entryKb.toFixed(0)} > ${ENTRY_BUDGET_KB} KB.`);
  console.error("            Move code into a lazy chunk (React.lazy / dynamic import) or raise the budget consciously.");
  failed = true;
}
if (totalKb > TOTAL_BUDGET_KB) {
  console.error(`[size-budget] FAIL — total JS over budget: ${totalKb.toFixed(0)} > ${TOTAL_BUDGET_KB} KB.`);
  failed = true;
}
if (failed) process.exit(1);
console.log("[size-budget] OK");
