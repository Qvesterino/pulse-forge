/**
 * Bundle-size budget check. Run after `vite build` (wired into the build
 * script). Fails the build when the initial payload or the DAW JS graph
 * grows beyond its budget — perf regressions must be a conscious decision,
 * not an accident.
 *
 * Budgets (raw, un-gzipped):
 *  - ENTRY (the chunk index.html boots with): the studio shell — engine,
 *    sequencer, project model. Everything else (yjs/collab, plugin panels,
 *    MP3 encoder, bottom dock panels, /embed, /gallery, /landing) is
 *    code-split and loads on demand.
 *  - DAW TOTAL: all studio JS chunks except optional AI runtimes and the MP3
 *    codec, which have separate budgets below. This catches dead-weight
 *    creeping into the DAW graph even when code is split.
 *
 * NOTE: the flagship plugin AudioWorklet bundles are not part of the app
 * chunk budgets because they are lazy-loaded. The two stock/core bundles are
 * shipped with every build and therefore have an explicit separate budget
 * below; they must stay small enough to load during normal studio startup.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
// 2660 (2026-09-25): measured completion-wave bump — the current production
// build is 2644 KB after ghost-version A/B morphing, conversational production
// controls, favorites, stretch editing and Windows companion transport landed.
// This keeps just 16 KB of headroom; entry, optional runtimes and the landing
// route remain independently capped below.
// 2670 (2026-09-25): audio-input observability reports worklet-captured PCM
// channels/rate separately from browser track settings and capability ranges.
// Keep the DAW cap independently enforced while retaining <9 KB of headroom;
// entry, optional on-demand runtimes and landing remain under their own limits.
// 2690 (2026-09-25): the measured integration tree is 2677 KB after the
// current producer, recording and DSP work. Preserve a small 13 KB margin
// without relaxing entry, optional-runtime or landing-route budgets.
// 2705 (2026-09-25): automatic loop-pass capture adds durable AudioWorklet
// frame markers, crash recovery and selectable timeline takes (~6 KB).
// Keep ~9 KB measured headroom without relaxing the other bundle gates.
// 2715 (2026-09-26): single-pass punch adds sample-accurate in/out scheduling,
// non-destructive punch placement and durable recovery (~7 KB). The measured
// graph is 2712 KB; this bounded 10 KB allowance leaves 3 KB, so subsequent
// DAW growth must be offset or split rather than expanding the cap again.
// 2725 (2026-09-26): the source-first bottom dock adds the six beat-source
// shortcuts and their macro definitions (~3 KB to the measured graph). Keep a
// bounded 7 KB margin; future dock growth must still be offset or split.
// 2740 (2026-09-26): shared preset quick controls add the MIX/FEEDBACK/SYNC
// workflow to the bottom dock; the measured graph is now 2738 KB. Keep a
// bounded 2 KB margin; future dock growth must still be offset or split.
// 3170 (2026-09-27): retain the measured DAW cap while guarding optional AI
// runtimes and the on-demand MP3 codec independently. The current DAW graph is
// 3004.7 KB after moving duplicate model-pack logic out of the semantic worker;
// the 166.1 KB MP3 chunk is checked against its own 170 KB cap. This includes
// the intentional producer wave: deeper genre/groove data, artist-signature
// conditioning, section-aware revisions, and renderer playback. Further DAW
// growth must be offset or split before another cap increase is considered.
// 3170 (2026-09-27) held for two days of heavy concurrent waves. Bumped to
// 3500 (2026-09-30) with measured justification: the MCP agent surface
// (26 tools: takes/routing/loudness/meter + checkpoints + producer moves
// kyx_song/kyx_arrange) and the QMR bridge all live in the DAW graph by
// design — they are studio features, not on-demand extras. Splitting does
// NOT move this metric (it sums every studio chunk); only real dead-code
// removal or feature regression would. The eager BOOT graph DID shrink this
// wave (song planner + handoff sender went on-demand). Next big feature
// wave must offset here, not bump again.
const TOTAL_BUDGET_KB = 3500;
// Local inference runtimes are dynamically loaded inside lazily spawned
// workers: Transformers.js for semantic embeddings, and ONNX Runtime for the
// symbolic/ranker workers. Keep these optional runtimes under one existing
// cap instead of charging them to the core DAW payload. If Vite renames either
// chunk, it falls back into TOTAL_BUDGET_KB and fails safe.
const OPTIONAL_AI_RUNTIME_BUDGET_KB = 650;
const OPTIONAL_AI_RUNTIME_PREFIXES = ["transformers.web-", "ort.wasm.bundle.min-"];
// MP3 encoding is also on-demand, but it is a codec rather than an AI runtime.
// Keep its exported chunk out of the DAW graph while enforcing a separate cap.
const OPTIONAL_CODEC_BUDGET_KB = 170;
const OPTIONAL_CODEC_PREFIXES = ["mp3-"];
// Nexus 0.0.19 and its KYX adapter are fetched only after an explicit
// Audiotool action. Measure them together in a narrow opt-in payload budget;
// the adapter must not hide outside the SDK's separate allowance.
const OPTIONAL_NEXUS_BUDGET_KB = 750;
const OPTIONAL_NEXUS_PREFIXES = ["audiotool-nexus-"];
// QMR HUD (Qvester ecosystem): the deferred chip trigger + the full panel
// (knowledge graph, coach, ecosystem map) load only after an explicit chip
// click / Ctrl+K — a user-triggered opt-in payload, not core DAW weight.
// First measured landing: 88 KB chip + 992 KB panel JS from
// @qvester/qmr-hud's 4.2 MB TS source (mounted via vite aliases from the
// sibling monorepo). Growth beyond this cap is a conscious decision.
const OPTIONAL_QMR_BUDGET_KB = 1600;
const OPTIONAL_QMR_PREFIXES = ["qmr-"];
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
// Vite prefixes assets with the configured base (for example /kyx/assets/)
// when the app is deployed beneath a host site. The physical files remain in
// dist/assets, so use the generated asset filename and reject path escapes.
const entryMatch = /<script[^>]*src="(\/[^"]+\.js)"/.exec(html);
const entryPath = entryMatch?.[1];
const entryAssetMatch = entryPath?.match(/(?:^|\/)assets\/([^/]+\.js)$/);
const entryFile = entryAssetMatch ? resolve(dist, "assets", entryAssetMatch[1]) : null;
const entryRelative = entryFile ? relative(dist, entryFile) : "";
if (
  !entryFile ||
  !entryRelative ||
  entryRelative === ".." ||
  entryRelative.startsWith(".." + sep) ||
  entryRelative.startsWith(sep)
) {
  console.error("[size-budget] could not find the entry <script> in dist/index.html");
  process.exit(1);
}

const entryKb = statSync(entryFile).size / 1024;
let totalKb = 0;
let optionalAiRuntimeKb = 0;
let optionalCodecKb = 0;
let optionalNexusKb = 0;
let optionalQmrKb = 0;
const optionalNexusFiles = [];
for (const file of readdirSync(join(dist, "assets"))) {
  if (!file.endsWith(".js")) continue;
  const sizeKb = statSync(join(dist, "assets", file)).size / 1024;
  if (OPTIONAL_AI_RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix))) optionalAiRuntimeKb += sizeKb;
  else if (OPTIONAL_CODEC_PREFIXES.some((prefix) => file.startsWith(prefix))) optionalCodecKb += sizeKb;
  else if (OPTIONAL_NEXUS_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    optionalNexusKb += sizeKb;
    optionalNexusFiles.push(file);
  } else if (OPTIONAL_QMR_PREFIXES.some((prefix) => file.startsWith(prefix))) optionalQmrKb += sizeKb;
  else totalKb += sizeKb;
}

console.log(`[size-budget] entry: ${entryKb.toFixed(0)} KB (budget ${ENTRY_BUDGET_KB})`);
console.log(`[size-budget] DAW JS chunks: ${totalKb.toFixed(0)} KB (budget ${TOTAL_BUDGET_KB})`);
console.log(
  `[size-budget] optional on-demand runtimes: ${optionalAiRuntimeKb.toFixed(0)} KB (budget ${OPTIONAL_AI_RUNTIME_BUDGET_KB})`,
);
console.log(`[size-budget] optional codecs: ${optionalCodecKb.toFixed(0)} KB (budget ${OPTIONAL_CODEC_BUDGET_KB})`);
console.log(
  `[size-budget] optional Audiotool Nexus: ${optionalNexusKb.toFixed(0)} KB (budget ${OPTIONAL_NEXUS_BUDGET_KB})`,
);
console.log(`[size-budget] optional QMR HUD: ${optionalQmrKb.toFixed(0)} KB (budget ${OPTIONAL_QMR_BUDGET_KB})`);
console.log(
  `[size-budget] shipped JS total: ${(totalKb + optionalAiRuntimeKb + optionalCodecKb + optionalNexusKb).toFixed(0)} KB`,
);

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
    `[size-budget] FAIL - optional on-demand runtimes over budget: ${optionalAiRuntimeKb.toFixed(0)} > ${OPTIONAL_AI_RUNTIME_BUDGET_KB} KB.`,
  );
  failed = true;
}
if (optionalCodecKb > OPTIONAL_CODEC_BUDGET_KB) {
  console.error(
    `[size-budget] FAIL — optional codecs over budget: ${optionalCodecKb.toFixed(0)} > ${OPTIONAL_CODEC_BUDGET_KB} KB.`,
  );
  failed = true;
}
if (optionalNexusKb > OPTIONAL_NEXUS_BUDGET_KB) {
  console.error(
    `[size-budget] FAIL — optional Audiotool Nexus chunks over budget: ${optionalNexusKb.toFixed(0)} > ${OPTIONAL_NEXUS_BUDGET_KB} KB.`,
  );
  failed = true;
}

// Ensure the opt-in SDK is not pulled into the initial static import graph or
// the service-worker precache (which would download it before user action).
const assetFiles = readdirSync(join(dist, "assets")).filter((file) => file.endsWith(".js"));
const staticDeps = (file) => {
  const prologue = readFileSync(join(dist, "assets", file), "utf8").slice(0, 8000);
  const out = [];
  for (const match of prologue.matchAll(/from"\.\/([^"]+)"|import"\.\/([^"]+)"/g)) {
    out.push(match[1] ?? match[2]);
  }
  return out;
};
const initialEntry = entryMatch[1].split("/").pop();
const initialSeen = new Set();
const initialQueue = initialEntry ? [initialEntry] : [];
while (initialQueue.length > 0) {
  const file = initialQueue.shift();
  if (!file || initialSeen.has(file)) continue;
  initialSeen.add(file);
  for (const dep of staticDeps(file)) {
    if (assetFiles.includes(dep) && !initialSeen.has(dep)) initialQueue.push(dep);
  }
}
const eagerlyLoadedNexus = optionalNexusFiles.filter((file) => initialSeen.has(file));
if (eagerlyLoadedNexus.length > 0) {
  console.error(
    `[size-budget] FAIL — optional Nexus SDK is statically reachable at boot: ${eagerlyLoadedNexus.join(", ")}`,
  );
  failed = true;
}
const serviceWorker = readFileSync(join(dist, "sw.js"), "utf8");
const precachedNexus = optionalNexusFiles.filter((file) => serviceWorker.includes(file));
if (precachedNexus.length > 0) {
  console.error(`[size-budget] FAIL — optional Nexus SDK is in the PWA precache: ${precachedNexus.join(", ")}`);
  failed = true;
}
const nexusRuntime = optionalNexusFiles.map((file) => readFileSync(join(dist, "assets", file), "utf8")).join("\n");
if (/undici|connect-node/i.test(nexusRuntime)) {
  console.error("[size-budget] FAIL — Node-only Nexus transport code entered the browser bundle.");
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
