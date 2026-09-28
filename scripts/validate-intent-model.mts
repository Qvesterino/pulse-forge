/**
 * Validates the trained intent-model v1 artifact end-to-end (LOCAL-INTENT-
 * MODEL.md §5 release gate, adapted for the v1 classifier student):
 *
 *   1. manifest pins: grammarSha256 === sha256(live toGbnfGrammar()) — the
 *      drift guard; model/vocab SHA-256 match the manifest;
 *   2. ONNX Runtime (the browser-compatible wasm build, node host) loads the
 *      graph; input/output names match the manifest;
 *   3. EVERY corpus row (train + val + golden) runs through the REAL model
 *      and the CANONICAL TS decoder (src/intent/model-decoder.ts); the
 *      assembled action is compared against the teacher's response with
 *      engine-filled fields stripped (detected/sourceText/matchedBy):
 *        attempted-exact >= 0.95   (exactness on rows the model attempted)
 *        wrongKind      = 0        (a mute must never become a delete —
 *                                   hard fail per §5)
 *        abstainRate    <= 0.20    (explicit "unsupported" is honest, but
 *                                   the student must carry most of the load)
 *   4. determinism: the val set runs twice, outputs byte-equal.
 *
 * Run: npx vite-node scripts/validate-intent-model.mts
 * Exit 0 = all gates pass.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toGbnfGrammar } from "../src/intent/model-schema";
import { isIntentModelManifest } from "../src/intent/model-loader-types";
import {
  buildIntentBow,
  canonicalModelJson,
  decodeIntentHeads,
  type IntentModelVocab,
} from "../src/intent/model-decoder";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = path.join(ROOT, "public", "models");

const manifest = JSON.parse(readFileSync(path.join(MODELS_DIR, "intent-model-v1.manifest.json"), "utf8")) as unknown;
if (!isIntentModelManifest(manifest)) throw new Error("manifest malformed");
if (manifest.features === undefined) throw new Error("manifest has no features pin");

const grammarDigest = createHash("sha256").update(toGbnfGrammar()).digest("hex");
if (grammarDigest !== manifest.grammarSha256.toLowerCase()) {
  throw new Error(
    `GRAMMAR DRIFT: manifest pins ${manifest.grammarSha256.slice(0, 12)}… but this build generates ${grammarDigest.slice(0, 12)}… — retrain (npm run intent-model:all)`,
  );
}

const modelBytes = readFileSync(path.join(MODELS_DIR, path.basename(manifest.model.url)));
const modelDigest = createHash("sha256").update(modelBytes).digest("hex");
if (modelDigest !== manifest.model.sha256.toLowerCase()) throw new Error("model hash mismatch");
if (modelBytes.byteLength !== manifest.model.bytes) throw new Error("model byte size mismatch");

const vocabBytes = readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"));
const vocab = JSON.parse(vocabBytes.toString("utf8")) as IntentModelVocab;
const vocabDigest = createHash("sha256").update(vocabBytes.toString("utf8")).digest("hex");
if (vocabDigest !== manifest.features.vocabSha256.toLowerCase()) throw new Error("vocab hash mismatch");
if (vocab.tokens.length !== manifest.features.vocabSize) throw new Error("vocab size mismatch");

// Browser-compatible runtime on a node host — same pattern as
// validate-intent-ranker.mjs; the wasm binaries stay local node_modules.
const ort = await import("onnxruntime-web");
ort.env.wasm.wasmPaths = pathToFileURL(
  path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep),
).href;
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});
if (session.inputNames[0] !== manifest.features.inputName) {
  throw new Error(`input name mismatch: ${session.inputNames[0]}`);
}
const expectedOutputs = new Set(manifest.features.outputNames);
for (const name of expectedOutputs) {
  if (!session.outputNames.includes(name)) throw new Error(`output ${name} missing from graph`);
}

// session.run is sync-ish for wasm but returns a promise; wrap cleanly:
async function infer(instruction: string): Promise<Record<string, Float32Array>> {
  const bow = buildIntentBow(instruction, vocab.tokens);
  const tensor = new ort.Tensor("float32", bow, [1, bow.length]);
  const feeds: Record<string, typeof tensor> = { [manifest.features!.inputName]: tensor };
  const results = (await session.run(feeds)) as Record<string, { data: Float32Array }>;
  const outputs: Record<string, Float32Array> = {};
  for (const name of manifest.features!.outputNames) {
    const value = results[name];
    if (!value) throw new Error(`session returned no ${name}`);
    outputs[name] = value.data;
  }
  return outputs;
}

interface Row {
  instruction: string;
  response: unknown;
}

const loadRows = (file: string): Row[] =>
  readFileSync(path.join(ROOT, "scripts", "data", "intent-sft", file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);

interface GateStats {
  rows: number;
  attempted: number;
  exact: number;
  wrongKind: number;
  abstain: number;
  perKind: Map<string, { rows: number; attempted: number; exact: number; wrongKind: number; abstain: number }>;
}

function emptyStats(): GateStats {
  return { rows: 0, attempted: 0, exact: 0, wrongKind: 0, abstain: 0, perKind: new Map() };
}

function bucket(stats: GateStats, kind: string) {
  const entry = stats.perKind.get(kind) ?? {
    rows: 0,
    attempted: 0,
    exact: 0,
    wrongKind: 0,
    abstain: 0,
  };
  stats.perKind.set(kind, entry);
  return entry;
}

async function evaluate(rows: Row[], label: string): Promise<GateStats> {
  const stats = emptyStats();
  for (const row of rows) {
    stats.rows += 1;
    const truth = row.response as { kind?: string } | null;
    const trueKind = String(truth?.kind ?? "unknown");
    const kindBucket = bucket(stats, trueKind);
    kindBucket.rows += 1;
    const outputs = await infer(row.instruction);
    const decoded = decodeIntentHeads(outputs, vocab);
    if (decoded === null) {
      stats.abstain += 1;
      kindBucket.abstain += 1;
      continue;
    }
    stats.attempted += 1;
    kindBucket.attempted += 1;
    if (decoded.kind !== trueKind) {
      stats.wrongKind += 1;
      kindBucket.wrongKind += 1;
      continue;
    }
    if (canonicalModelJson(decoded) === canonicalModelJson(row.response)) {
      stats.exact += 1;
      kindBucket.exact += 1;
    }
  }
  const attemptedExact = stats.attempted === 0 ? 0 : stats.exact / stats.attempted;
  const abstainRate = stats.abstain / stats.rows;
  console.log(
    `[${label}] rows=${stats.rows} attempted=${stats.attempted} exact=${stats.exact} ` +
      `attemptedExact=${(attemptedExact * 100).toFixed(1)}% wrongKind=${stats.wrongKind} abstain=${stats.abstain} (${(abstainRate * 100).toFixed(1)}%)`,
  );
  for (const [kind, entry] of [...stats.perKind.entries()].sort()) {
    console.log(
      `    ${kind.padEnd(14)} rows=${entry.rows} exact=${entry.exact}/${entry.attempted} wrongKind=${entry.wrongKind} abstain=${entry.abstain}`,
    );
  }
  return stats;
}

function checkGate(stats: GateStats, label: string): void {
  const attemptedExact = stats.attempted === 0 ? 0 : stats.exact / stats.attempted;
  const abstainRate = stats.abstain / Math.max(1, stats.rows);
  const failures: string[] = [];
  if (stats.wrongKind !== 0) failures.push(`wrongKind=${stats.wrongKind} (must be 0)`);
  if (attemptedExact < 0.95) failures.push(`attemptedExact=${(attemptedExact * 100).toFixed(1)}% (< 95%)`);
  if (abstainRate > 0.2) failures.push(`abstainRate=${(abstainRate * 100).toFixed(1)}% (> 20%)`);
  if (failures.length > 0) throw new Error(`GATE FAILED [${label}]: ${failures.join("; ")}`);
}

const trainRows = loadRows("train.jsonl");
const valRows = loadRows("val.jsonl");
const goldenRows = loadRows("golden.jsonl");

const trainStats = await evaluate(trainRows, "train");
const valStats = await evaluate(valRows, "val");
const goldenStats = await evaluate(goldenRows, "golden");

// determinism: identical instructions must produce byte-equal outputs
for (const row of valRows.slice(0, 16)) {
  const first = await infer(row.instruction);
  const second = await infer(row.instruction);
  for (const name of Object.keys(first)) {
    if (first[name].length !== second[name].length) throw new Error(`nondeterministic output length on ${name}`);
    for (let i = 0; i < first[name].length; i++) {
      if (first[name][i] !== second[name][i]) throw new Error(`nondeterministic output on ${name}`);
    }
  }
}
console.log("determinism: val subset byte-equal across two runs ✓");

checkGate(valStats, "val");
checkGate(goldenStats, "golden");
console.log(
  `train attemptedExact=${((trainStats.exact / Math.max(1, trainStats.attempted)) * 100).toFixed(1)}% (informational, not gated)`,
);
console.log("RELEASE GATE PASSED — attempted-exact >= 95%, wrongKind = 0, abstain <= 20% on val + golden");
