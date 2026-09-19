/**
 * E2E smoke for the SEMANTIC layer (INTENT_ENGINE.md T1 krok 2) with the
 * REAL model: loads the fetched multilingual MiniLM (q8) through
 * transformers.js from public/models/semantic/, embeds the curated corpus
 * via the SAME buildSemanticCorpus used in the app, and asserts that weak
 * keyword parses resolve by MEANING — EN and SK, known and unknown phrasings.
 *
 * Run: npx vite-node scripts/smoke-semantic.mts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SEMANTIC_DIR = path.join(ROOT, "public", "models", "semantic");
const manifest = JSON.parse(readFileSync(path.join(SEMANTIC_DIR, "manifest.json"), "utf8"));

// transformers.js in node: force the local model dir (offline-first).
const { pipeline, env } = await import("@huggingface/transformers");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = path.resolve(SEMANTIC_DIR) + path.sep;

console.log(`[smoke] loading ${manifest.modelId} (q8) …`);
const extractor = await pipeline("feature-extraction", manifest.modelId, { dtype: "q8" });

const { semanticIntentFor, resetSemanticCorpusCache } = await import("../src/intent/semantic");

// Real embedder wired into the SAME matching logic the app uses.
const embed = async (texts: string[]) => {
  const output = (await extractor(texts, { pooling: "mean", normalize: true })) as {
    data: Float32Array;
    dims: number[];
  };
  const [rows, dim] = output.dims;
  const out: Float32Array[] = [];
  for (let row = 0; row < rows; row++) out.push(output.data.slice(row * dim, (row + 1) * dim));
  return out;
};

// Warm up + build the corpus through the app's matching function.
await embed(["warmup"]);
resetSemanticCorpusCache();

const checks: Array<[string, unknown, unknown]> = [];
const resolve = async (text: string) => {
  const match = await semanticIntentFor(text, { embed });
  return match;
};

// 1. unknown-artist phrasing that the KEYWORD parser cannot resolve
const ts = await resolve("beat in the style of the rapper from astroworld with dark 808s");
checks.push([
  `unknown dark-trap phrasing resolves to a trap patch (got: ${ts ? String(ts.input.genre) : "null"}, label ${ts?.label ?? "—"}, score ${ts?.score ?? 0})`,
  ts !== null && ts.input.genre === "trap",
]);

// 2. SK phrasing with no EN keywords
const sk = await resolve("pomaly pokojný zvuk pre scénu");
checks.push([
  `SK ambient phrasing resolves (got: ${sk ? String(sk.input.genre) : "null"}, score ${sk?.score ?? 0})`,
  sk !== null && sk.input.genre === "ambient",
]);

// 3. unknown house-adjacent phrasing
const house = await resolve("groovy party groove that makes people dance");
checks.push([
  `party groove resolves to house patch (got: ${house ? String(house.input.genre) : "null"}, score ${house?.score ?? 0})`,
  house !== null && house.input.genre === "house",
]);

// 4. nonsense stays BELOW threshold → null (keyword fallback deserves it)
const nonsense = await resolve("please send me an email about quarterly taxes");
checks.push([
  `unrelated nonsense stays null (score ${nonsense?.score ?? "null"})`,
  nonsense === null || nonsense.score < 0.5,
]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) failed += 1;
}
console.log(`[smoke] ${checks.length - failed}/${checks.length} semantic checks passed`);
if (failed > 0) process.exit(1);
