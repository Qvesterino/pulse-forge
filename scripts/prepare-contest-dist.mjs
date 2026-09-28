/**
 * Contest deploy artifact — KYX × Audiotool "Let's Build" submission.
 *
 * Takes the production `dist/` and produces `dist-contest/`: the full app,
 * minus the three heavyweight optional model buckets (semantic 130 MB,
 * audio classifier 87 MB, ORT runtime 80 MB). Every one of those loads
 * behind the timeout + circuit breaker + deterministic heuristic fallback
 * (ARCHITECTURE invariant 4), so the trimmed build degrades gracefully:
 * intent generation, audition, export and the Audiotool Nexus flow are
 * untouched. This also clears Cloudflare Pages' 25 MiB per-file limit,
 * which the full ORT wasm files exceed.
 *
 * Usage: node scripts/prepare-contest-dist.mjs   (run after `npm run build`)
 */
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIST = resolve(process.cwd(), "dist");
const OUT = resolve(process.cwd(), "dist-contest");
const TRIM = [
  "models/semantic",
  "models/audio",
  "models/ort",
  // Vite also emits the ORT runtime wasm copies into assets/ — the asyncify
  // build alone is 26 MB, past Cloudflare Pages' 25 MiB per-file ceiling.
  "assets/ort-wasm",
];

if (!existsSync(DIST)) {
  console.error("[contest] dist/ missing — run `npm run build` first.");
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
cpSync(DIST, OUT, { recursive: true });
for (const dir of TRIM) {
  if (dir.endsWith("ort-wasm")) {
    const assets = resolve(OUT, "assets");
    if (!existsSync(assets)) continue;
    for (const file of readdirSync(assets)) {
      if (file.startsWith("ort-wasm")) rmSync(resolve(assets, file), { force: true });
    }
    continue;
  }
  const target = resolve(OUT, dir);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

writeFileSync(
  resolve(OUT, "MODELS-NOTE.txt"),
  [
    "This is the contest build of KYX (Pulse Forge).",
    "",
    "The optional heavyweight model buckets (semantic embeddings, audio classifier,",
    "ONNX Runtime wasm) are omitted to fit CDN per-file size limits. The app loads",
    "these behind a timeout + circuit breaker and falls back to its built-in",
    "deterministic heuristics — generation, audition, export and the Audiotool",
    "Nexus connector are fully functional without them.",
    "",
    "The small intent-ranker and symbolic-prior ONNX models are still shipped;",
    "if the ORT runtime is absent the ranker client skips to the deterministic",
    "fallback by design.",
  ].join("\n"),
);

console.log(`[contest] dist-contest/ ready (trimmed: ${TRIM.join(", ")})`);
