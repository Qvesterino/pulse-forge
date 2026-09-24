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
// 2400: set with the flagship-plugin waves. 2450 (2026-09-22): conscious bump —
// the intent waves (user style vector, melodic prior v2, effect-intent catalog)
// and the MORPH preset/scene data shipped ~16 KB of real feature code past the
// old ceiling; the landing-route regression that actually mattered was fixed
// the same day by cutting the static renderer→AudioEngine edge out of the
// landing/embed/intent-audition graphs (landing on-demand 729 → 443 KB).
// 2500 (2026-09-22): conscious MRT2 bump — the provider-neutral companion
// protocol, bounded resample runtime and deliberate localhost Inspector surface
// are shipped without model weights or native ML dependencies.
// 2600 (2026-09-24): conscious product-completion bump — ghost-version A/B
// morphing, conversational production controls and the Windows companion
// transport are shipped as real capability, with the landing closure still
// independently capped below.
const TOTAL_BUDGET_KB = 2600;
// Local inference runtimes are dynamically loaded inside lazily spawned
// workers: Transformers.js for semantic embeddings, and ONNX Runtime for the
// symbolic/ranker workers. Keep these optional runtimes under one existing
// cap instead of charging them to the core DAW payload. If Vite renames either
// chunk, it falls back into TOTAL_BUDGET_KB and fails safe.
const OPTIONAL_AI_RUNTIME_BUDGET_KB = 650;
const OPTIONAL_AI_RUNTIME_PREFIXES = ["transformers.web-", "ort.wasm.bundle.min-"];
// 150: deliberate bump (was 120 — the gate had been red since kaskada's
// 32-band spectral DSP landed in the core bundle at ~137 KB). The de-cramped
// stock EQ worklet pushed the measured size to 144 KB. The core bundle stays
// core on purpose: eq/gate/limiter/sidechain processors must be available
// before the lazy plugin worklets load — splitting them out would trade a
// number here for a load-order risk in the audio path.
const CORE_WORKLET_BUDGET_KB = 150;
// Fáza C (viral growth plan §5) — the landing conversion budget. The landing
// route (LandingPage chunk + its transitive static imports: embed player,
// intent parser, command apply, renderer) must stay free of the studio UI,
// the semantic model runtime and heavy workers; its on-demand payload is
// measured at 493 KB (2026-09-20) — 600 gives ~20% headroom. Raise only as a
// conscious decision; the guards below fail hard instead.
const LANDING_ROUTE_BUDGET_KB = 600;
const LANDING_ENTRY_PREFIX = "LandingPage-";
// Modules that must never statically reach the landing route. The semantic
// model runtime and the studio shell have their own routes/chunks; if one of
// these appears in the closure, a bad import crept into the landing graph.
const LANDING_FORBIDDEN = ["transformers.web-", "App-"];

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
let optionalAiRuntimeKb = 0;
for (const file of readdirSync(join(dist, "assets"))) {
  if (!file.endsWith(".js")) continue;
  const sizeKb = statSync(join(dist, "assets", file)).size / 1024;
  if (OPTIONAL_AI_RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix))) optionalAiRuntimeKb += sizeKb;
  else totalKb += sizeKb;
}

console.log(`[size-budget] entry: ${entryKb.toFixed(0)} KB (budget ${ENTRY_BUDGET_KB})`);
console.log(`[size-budget] DAW JS chunks: ${totalKb.toFixed(0)} KB (budget ${TOTAL_BUDGET_KB})`);
console.log(
  `[size-budget] optional AI runtimes: ${optionalAiRuntimeKb.toFixed(0)} KB (budget ${OPTIONAL_AI_RUNTIME_BUDGET_KB})`,
);
console.log(`[size-budget] shipped JS total: ${(totalKb + optionalAiRuntimeKb).toFixed(0)} KB`);

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
  console.error(
    "            Move code into a lazy chunk (React.lazy / dynamic import) or raise the budget consciously.",
  );
  failed = true;
}
if (totalKb > TOTAL_BUDGET_KB) {
  console.error(`[size-budget] FAIL — DAW JS over budget: ${totalKb.toFixed(0)} > ${TOTAL_BUDGET_KB} KB.`);
  failed = true;
}
if (optionalAiRuntimeKb > OPTIONAL_AI_RUNTIME_BUDGET_KB) {
  console.error(
    `[size-budget] FAIL — optional AI runtimes over budget: ${optionalAiRuntimeKb.toFixed(0)} > ${OPTIONAL_AI_RUNTIME_BUDGET_KB} KB.`,
  );
  failed = true;
}
if (coreWorkletKb > CORE_WORKLET_BUDGET_KB) {
  console.error(
    `[size-budget] FAIL — core worklets over budget: ${coreWorkletKb.toFixed(0)} > ${CORE_WORKLET_BUDGET_KB} KB.`,
  );
  failed = true;
}

// ── Landing route closure (Fáza C) ────────────────────────────────────────
// BFS over the static import statements at the top of each built chunk,
// starting from the LandingPage chunk. Vite emits `from"./X.js"` /
// `import"./X.js"` for every static edge, so the closure is exactly what the
// browser downloads for the landing route beyond (plus) the shared entry.
const landingEntry = readdirSync(join(dist, "assets")).find(
  (file) => file.endsWith(".js") && file.startsWith(LANDING_ENTRY_PREFIX),
);
if (!landingEntry) {
  console.error(`[size-budget] FAIL — no ${LANDING_ENTRY_PREFIX}*.js chunk in dist/assets (landing route moved?).`);
  failed = true;
} else {
  const jsFiles = readdirSync(join(dist, "assets")).filter((file) => file.endsWith(".js"));
  const sizeOf = (file) => statSync(join(dist, "assets", file)).size / 1024;
  // Static import edges live in the import prologue of each chunk.
  const staticDeps = (file) => {
    const prologue = readFileSync(join(dist, "assets", file), "utf8").slice(0, 8000);
    const out = [];
    for (const match of prologue.matchAll(/from"\.\/([^"]+)"|import"\.\/([^"]+)"/g)) {
      out.push(match[1] ?? match[2]);
    }
    return out;
  };
  const seen = new Set([landingEntry]);
  const queue = [landingEntry];
  let landingOnDemandKb = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    landingOnDemandKb += sizeOf(file);
    for (const dep of staticDeps(file)) {
      if (!seen.has(dep) && jsFiles.includes(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  // The entry chunk loads on every route — budget the ON-DEMAND payload.
  const entryBase = entryMatch[1].split("/").pop();
  if (entryBase && seen.has(entryBase)) landingOnDemandKb -= sizeOf(entryBase);
  const forbiddenHits = [...seen].filter((file) => LANDING_FORBIDDEN.some((bad) => file.startsWith(bad)));
  console.log(
    `[size-budget] landing route: ${landingOnDemandKb.toFixed(0)} KB on-demand across ${seen.size} chunks (budget ${LANDING_ROUTE_BUDGET_KB})`,
  );
  if (landingOnDemandKb > LANDING_ROUTE_BUDGET_KB) {
    console.error(
      `[size-budget] FAIL — landing route over budget: ${landingOnDemandKb.toFixed(0)} > ${LANDING_ROUTE_BUDGET_KB} KB.`,
    );
    failed = true;
  }
  if (forbiddenHits.length > 0) {
    console.error(`[size-budget] FAIL — forbidden modules reached the landing route: ${forbiddenHits.join(", ")}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("[size-budget] OK");
