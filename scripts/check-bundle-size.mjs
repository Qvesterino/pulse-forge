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
 * NOTE: the flagship plugin AudioWorklet bundles are not part of the app
 * chunk budgets because they are lazy-loaded. The two stock/core bundles are
 * shipped with every build and therefore have an explicit separate budget
 * below; they must stay small enough to load during normal studio startup.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 1010: pattern-recorder / topbar wave (2bd7349) pushed the measured entry to
// 1004 KB. Conscious bump to keep main buildable mid-wave — re-tighten by
// lazy-chunking the recorder UI once the wave settles.
// 1030: preset loudness normalization map (199 entries, ~7 KB) + the engine
// norm stage join the entry by design — the map must load with the engine so
// every chain build sees the same gains.
// 1070: symbolic-prior / favorites wave continues growing the entry; the UX
// hierarchy pass adds ~2 KB on top. Same debt: chunk the recorder/prior UIs
// once the wave settles.
const ENTRY_BUDGET_KB = 1070;
const TOTAL_BUDGET_KB = 2400;
// The semantic intent worker dynamically imports Transformers.js only after a
// weak keyword parse and a successful local-model probe. Keep that optional
// runtime under its own cap instead of silently raising the normal DAW budget.
// If Vite renames the chunk, it falls back into TOTAL_BUDGET_KB and fails safe.
const OPTIONAL_SEMANTIC_BUDGET_KB = 650;
const OPTIONAL_SEMANTIC_PREFIX = "transformers.web-";
// 150: deliberate bump (was 120 — the gate had been red since kaskada's
// 32-band spectral DSP landed in the core bundle at ~137 KB). The de-cramped
// stock EQ worklet pushed the measured size to 144 KB. The core bundle stays
// core on purpose: eq/gate/limiter/sidechain processors must be available
// before the lazy plugin worklets load — splitting them out would trade a
// number here for a load-order risk in the audio path.
const CORE_WORKLET_BUDGET_KB = 150;

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
let optionalSemanticKb = 0;
for (const file of readdirSync(join(dist, "assets"))) {
  if (!file.endsWith(".js")) continue;
  const sizeKb = statSync(join(dist, "assets", file)).size / 1024;
  if (file.startsWith(OPTIONAL_SEMANTIC_PREFIX)) optionalSemanticKb += sizeKb;
  else totalKb += sizeKb;
}

console.log(`[size-budget] entry: ${entryKb.toFixed(0)} KB (budget ${ENTRY_BUDGET_KB})`);
console.log(`[size-budget] DAW JS chunks: ${totalKb.toFixed(0)} KB (budget ${TOTAL_BUDGET_KB})`);
console.log(
  `[size-budget] optional semantic runtime: ${optionalSemanticKb.toFixed(0)} KB (budget ${OPTIONAL_SEMANTIC_BUDGET_KB})`,
);
console.log(`[size-budget] shipped JS total: ${(totalKb + optionalSemanticKb).toFixed(0)} KB`);

let coreWorkletKb = 0;
for (const file of ["bitcrusher-worklet.js", "core-worklet.js"]) {
  const path = join(dist, file);
  if (!statSync(path).isFile()) {
    console.error(`[size-budget] FAIL — missing core worklet: dist/${file}`);
    process.exit(1);
  }
  coreWorkletKb += statSync(path).size / 1024;
}
console.log(`[size-budget] core worklets: ${coreWorkletKb.toFixed(0)} KB (budget ${CORE_WORKLET_BUDGET_KB})`);

let failed = false;
if (entryKb > ENTRY_BUDGET_KB) {
  console.error(`[size-budget] FAIL — entry chunk over budget: ${entryKb.toFixed(0)} > ${ENTRY_BUDGET_KB} KB.`);
  console.error("            Move code into a lazy chunk (React.lazy / dynamic import) or raise the budget consciously.");
  failed = true;
}
if (totalKb > TOTAL_BUDGET_KB) {
  console.error(`[size-budget] FAIL — DAW JS over budget: ${totalKb.toFixed(0)} > ${TOTAL_BUDGET_KB} KB.`);
  failed = true;
}
if (optionalSemanticKb > OPTIONAL_SEMANTIC_BUDGET_KB) {
  console.error(
    `[size-budget] FAIL — optional semantic runtime over budget: ${optionalSemanticKb.toFixed(0)} > ${OPTIONAL_SEMANTIC_BUDGET_KB} KB.`,
  );
  failed = true;
}
if (coreWorkletKb > CORE_WORKLET_BUDGET_KB) {
  console.error(
    `[size-budget] FAIL — core worklets over budget: ${coreWorkletKb.toFixed(0)} > ${CORE_WORKLET_BUDGET_KB} KB.`,
  );
  failed = true;
}
if (failed) process.exit(1);
console.log("[size-budget] OK");
