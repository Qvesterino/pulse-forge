/**
 * Writes public/models/intent-model-v1.manifest.json AFTER a successful
 * training run (scripts/train-intent-model.py).
 *
 * The manifest pins the artifact to THIS build of the engine:
 *   - grammarSha256 = sha256(toGbnfGrammar()) computed from the LIVE
 *     TypeScript grammar (model-schema.ts) — python cannot produce this,
 *     which is exactly why the manifest is written HERE and not by the
 *     trainer. The loader worker re-computes the digest at load time and
 *     REFUSES a model trained against a drifted action grammar.
 *   - model SHA-256 + byte size over the exported ONNX
 *   - vocab SHA-256 + head layout under `features` — the runtime decoder
 *     reads its class lists from the vocab artifact, never from code
 *
 * Run: npx vite-node scripts/write-intent-model-manifest.mts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toGbnfGrammar } from "../src/intent/model-schema";
import { isIntentModelManifest } from "../src/intent/model-loader-types";
import type { IntentModelVocab } from "../src/intent/model-decoder";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = path.join(ROOT, "public", "models");
const REPORT_PATH = path.join(ROOT, "scripts", "data", "intent-model-report.json");

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

const report = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as {
  modelVersion: string;
  trainRows: number;
  valRows: number;
  goldenRows: number;
  valHeadAccuracy: Record<string, number>;
  vocabSize: number;
};
const modelBytes = readFileSync(path.join(MODELS_DIR, "intent-model-v1.onnx"));
const vocabBytes = readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"));
const vocab = JSON.parse(vocabBytes.toString("utf8")) as IntentModelVocab;

if (report.modelVersion !== "intent-model.v1") throw new Error(`unexpected report modelVersion ${report.modelVersion}`);
if (vocab.version !== 1 || !Array.isArray(vocab.tokens) || vocab.heads.length === 0) {
  throw new Error("vocab artifact malformed");
}
const meanValAccuracy =
  Object.values(report.valHeadAccuracy).reduce((sum, value) => sum + value, 0) /
  Object.values(report.valHeadAccuracy).length;

const manifest = {
  intentModelVersion: "intent-model.v1",
  schemaVersion: 1,
  // THE DRIFT PIN — live grammar at manifest-write time; the loader worker
  // recomputes toGbnfGrammar() at load and refuses on mismatch.
  grammarSha256: sha256(toGbnfGrammar()),
  runtime: {
    // The ONNX backend adapter (vite: src/... imported by the worker) — the
    // GGUF/llama.cpp path keeps the same contract for a future model.
    kind: "onnx-intent-v1",
    module: "/models/llm/intent-runtime.js",
    export: "createIntentLlmRuntime",
  },
  model: {
    url: "/models/intent-model-v1.onnx",
    bytes: modelBytes.byteLength,
    sha256: sha256(modelBytes),
  },
  prompt: {
    system: "You map a music-production instruction to one canonical action JSON object. Output only the JSON.",
    instructionTemplate: "INSTRUCTION: {instruction}\nACTION:",
  },
  generation: {
    maxTokens: 1,
    temperature: 0,
  },
  features: {
    version: "intent-features.v1",
    // raw file bytes — the validator hashes the file, not a re-serialization
    vocabSha256: sha256(vocabBytes),
    vocabSize: vocab.tokens.length,
    url: "/models/intent-model-v1.vocab.json",
    inputName: "features",
    outputNames: vocab.heads.map((head) => `head_${head.name}`),
    heads: vocab.heads,
  },
  report: {
    // patched to true ONLY by scripts/validate-intent-model.mts when the
    // assembled gate passes; the loader refuses models without it
    gatePassed: false,
    trainRows: report.trainRows,
    valRows: report.valRows,
    goldenRows: report.goldenRows,
    valHeadAccuracyMean: Number(meanValAccuracy.toFixed(4)),
    gate: "scripts/validate-intent-model.mts — attempted-exact >= 0.95, wrongKind = 0",
  },
};

if (!isIntentModelManifest(manifest)) {
  throw new Error("assembled manifest failed isIntentModelManifest — refusing to write");
}
writeFileSync(path.join(MODELS_DIR, "intent-model-v1.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `manifest written: grammar ${manifest.grammarSha256.slice(0, 12)}…  model ${manifest.model.bytes} B ${manifest.model.sha256.slice(0, 12)}…`,
);
