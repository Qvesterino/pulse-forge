/**
 * DEAD-WEIGHT AUDIT — the measurement the DAW-JS budget rule demands.
 *
 * The rule in scripts/check-bundle-size.mjs (2026-10-23):
 *
 *   "THE TIGHTENING TRIGGER HAS FIRED. ... The next growth must therefore
 *    PAY IT BACK: it may not come with another raise of this number. It must
 *    come with a dead-weight audit that finds chunks nothing reaches, or
 *    with the boot path coming down."
 *
 * This script IS that audit, made repeatable. It answers the three
 * questions a raise has to answer:
 *
 *   1. REACHABILITY — is any chunk in dist/assets unreachable from the
 *      entry? An unreachable chunk is charged to the budget while no user
 *      and no module can load it: dead weight by definition.
 *   2. DUPLICATION — is any source module shipped in more than one chunk?
 *      Rollup hoists shared code into ONE chunk, so the same bytes shipping
 *      twice are dead weight too. (Worker bundles legitimately hold their
 *      own copies, so they are counted separately.)
 *   3. SOURCE — which files under src/ never make it into any built chunk,
 *      and are referenced nowhere else? Those are bytes nobody can load.
 *
 * It MEASURES; it never deletes. The diet is a product decision, and this
 * script only tells you where the weight is.
 *
 * Usage: node scripts/audit-dead-weight.mjs [distDir] [repoRoot]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");
const repo = resolve(process.argv[3] ?? resolve("."));
const assetsDir = join(dist, "assets");

if (!existsSync(assetsDir)) {
  console.error(`[dead-weight] no ${assetsDir} — run a production build first`);
  process.exit(2);
}

/** The optional buckets the budget script charges separately. */
const OPTIONAL = [
  "transformers.web-",
  "ort.wasm.bundle.min-",
  "mastering-ranker-worker-",
  "ort.bundle.min-",
  "mp3-",
  "flac-codec-",
  "audiotool-nexus-",
  "qmr-",
  "pack-presets-",
];

// ── 1. reachability ──────────────────────────────────────────────────────
const html = readFileSync(join(dist, "index.html"), "utf-8");
const entryFiles = [
  ...new Set(
    [
      ...html.matchAll(/<script[^>]*src="\/[^"]*assets\/([^/"]+\.js)"/g),
      ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/[^"]*assets\/([^/"]+\.js)"/g),
    ].map((m) => m[1]),
  ),
];

const allJs = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));

// Vite emits `from"./x.js"`, `import"./x.js"`, `import("./x.js")` and
// `new URL("./x.js", import.meta.url)`. Worker chunks are referenced with an
// ABSOLUTE path (`new URL("/assets/worker.js", import.meta.url)`), so the
// pattern must accept both "./x.js" and "/assets/x.js".
const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](?:\.\/|\/assets\/)?([^"']+\.js)["']/g;
const URL_RE = /new\s+URL\(\s*["'](?:\.\/|\/assets\/)?([^"']+\.js)["']/g;

const graph = new Map();
for (const file of allJs) {
  const src = readFileSync(join(assetsDir, file), "utf-8");
  const deps = new Set();
  for (const re of [IMPORT_RE, URL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = m[1];
      if (target && allJs.includes(target)) deps.add(target);
    }
  }
  graph.set(file, deps);
}

const reachable = new Set();
const queue = [...entryFiles.filter((f) => allJs.includes(f))];
while (queue.length) {
  const cur = queue.pop();
  if (reachable.has(cur)) continue;
  reachable.add(cur);
  for (const d of graph.get(cur) ?? []) if (!reachable.has(d)) queue.push(d);
}

const kb = (f) => statSync(join(assetsDir, f)).size / 1024;
const orphans = allJs.filter((f) => !reachable.has(f));

// ── 2. duplication (needs the sourcemap build) ──────────────────────────
const sourcemapDir = join(dist, "..", "dist-sm");
const hasSourcemaps = existsSync(join(sourcemapDir, "assets"));
const moduleChunks = new Map(); // module -> Set(chunk)
if (hasSourcemaps) {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const decodeVlq = (seg) => {
    const out = [];
    let shift = 0;
    let value = 0;
    for (const ch of seg) {
      const digit = B64.indexOf(ch);
      if (digit < 0) continue;
      const cont = digit & 32;
      value += (digit & 31) << shift;
      if (cont) {
        shift += 5;
        continue;
      }
      const neg = value & 1;
      value >>= 1;
      out.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
    return out;
  };
  const smAssets = join(sourcemapDir, "assets");
  for (const file of readdirSync(smAssets)) {
    if (!file.endsWith(".js.map")) continue;
    const chunkName = file.slice(0, -4);
    const map = JSON.parse(readFileSync(join(smAssets, file), "utf-8"));
    for (const s of map.sources) {
      const abs = resolve(smAssets, s);
      if (!moduleChunks.has(abs)) moduleChunks.set(abs, new Set());
      moduleChunks.get(abs).add(chunkName);
    }
  }
}

// ── 3. source reachability ──────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const srcFiles = walk(join(repo, "src"));
const inGraph = new Set();
// The sourcemap build (vite build --sourcemap --outDir dist-sm) is what
// maps a source file to a chunk. Without it the source-level answer is
// unknown, and the honest thing is to say so rather than report 100%
// "not built".
const smDir = join(repo, "dist-sm", "assets");
const haveSourcemaps = existsSync(smDir);
if (haveSourcemaps) {
  for (const file of readdirSync(smDir)) {
    if (!file.endsWith(".js.map")) continue;
    const map = JSON.parse(readFileSync(join(smDir, file), "utf-8"));
    for (const s of map.sources) inGraph.add(resolve(smDir, s));
  }
}
// ── report ───────────────────────────────────────────────────────────────
console.log(`[dead-weight] dist: ${dist}`);
console.log(`[dead-weight] js chunks: ${allJs.length}, reachable from the entry: ${reachable.size}`);

if (orphans.length) {
  console.log(`\n[dead-weight] UNREACHABLE CHUNKS — charged to the budget, loadable by nobody:`);
  let total = 0;
  for (const f of orphans.sort((a, b) => kb(b) - kb(a))) {
    total += kb(f);
    console.log(`  ${kb(f).toFixed(1).padStart(9)} KB  ${f}`);
  }
  console.log(`[dead-weight] unreachable weight: ${total.toFixed(1)} KB`);
} else {
  console.log("[dead-weight] unreachable chunks: NONE — every chunk is reachable.");
}

if (moduleChunks.size) {
  const isWorker = (c) => /worker|analyzer|pitch-tracker|warp-render|ir-generator|onset/i.test(c);
  const dupMain = [];
  const dupWorker = [];
  for (const [mod, chunks] of moduleChunks) {
    if (chunks.size < 2) continue;
    const main = [...chunks].filter((c) => !isWorker(c));
    if (main.length > 1) dupMain.push([mod, main]);
    else dupWorker.push([mod, chunks]);
  }
  console.log(`\n[dead-weight] modules shipped in >1 chunk:`);
  console.log(`  inside the MAIN graph (removable): ${dupMain.length}`);
  for (const [mod, chunks] of dupMain.slice(0, 20)) {
    console.log(`    ${relative(repo, mod).split(sep).join("/")}  <- ${chunks.join(", ")}`);
  }
  console.log(`  inside WORKER bundles (structural, a worker owns its copy): ${dupWorker.length}`);
}

const notBuilt = srcFiles.filter((f) => !inGraph.has(f));
if (!haveSourcemaps) {
  console.log(
    "\n[dead-weight] src-file census: SKIPPED — no sourcemap build found.\n" +
      "             Run: vite build --sourcemap --outDir dist-sm\n" +
      "             (the chunk-level answers above need no sourcemaps)",
  );
} else {
  console.log(`\n[dead-weight] src files: ${srcFiles.length}, not present in any built chunk: ${notBuilt.length}`);
  console.log(
    "[dead-weight] NOTE: a file absent from the build is usually a WORKER entry, a type-only\n" +
      "             declaration (.d.ts) or dev-only tooling — none of which ship as bundle bytes.",
  );
  const unreferenced = notBuilt.filter((f) => {
    const stem = f
      .split(/[\\/]/)
      .pop()
      .replace(/\.(ts|tsx|js|mjs)$/, "");
    const others = walk(join(repo, "tests")).concat(walk(join(repo, "scripts")));
    return !others.some((o) => o !== f && new RegExp(`\\b${stem}\\b`).test(readFileSync(o, "utf-8")));
  });
  if (unreferenced.length) {
    console.log(`\n[dead-weight] not built AND referenced nowhere in tests/scripts:`);
    for (const f of unreferenced) {
      console.log(
        `  ${(statSync(f).size / 1024).toFixed(1).padStart(8)} KB  ${relative(repo, f).split(sep).join("/")}`,
      );
    }
  }
}
