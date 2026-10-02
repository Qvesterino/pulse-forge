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
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toGbnfGrammar } from "../src/intent/model-schema";
import { INTENT_MODEL_ABSTAIN_MARGIN, INTENT_MODEL_KIND_MARGIN } from "../src/intent/model-decoder";
import { isIntentModelManifest } from "../src/intent/model-loader-types";
import {
  buildIntentBow,
  canonicalModelJson,
  decodeIntentHeads,
  type IntentModelVocab,
} from "../src/intent/model-decoder";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = path.join(ROOT, "public", "models");
const DATA_DIR = path.join(ROOT, "scripts", "data", "intent-sft");
const VALIDATION_REPORT_PATH = path.join(ROOT, "scripts", "data", "intent-model-validation-report.json");
const MANIFEST_PATH = path.join(MODELS_DIR, "intent-model-v1.manifest.json");
const MODEL_SCHEMA_PATH = path.join(ROOT, "src", "intent", "model-schema.ts");
const MODEL_DECODER_PATH = path.join(ROOT, "src", "intent", "model-decoder.ts");
const VALIDATOR_SOURCE_PATH = path.join(ROOT, "scripts", "validate-intent-model.mts");

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));

const manifestBytes = readFileSync(MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
if (!isIntentModelManifest(manifest)) throw new Error("manifest malformed");
if (manifest.features === undefined) throw new Error("manifest has no features pin");
const validatorSourceBytes = readFileSync(VALIDATOR_SOURCE_PATH);
const decoderSourceBytes = readFileSync(MODEL_DECODER_PATH);
const schemaSourceBytes = readFileSync(MODEL_SCHEMA_PATH);
const modelPath = path.join(MODELS_DIR, path.basename(manifest.model.url));
const vocabPath = path.join(MODELS_DIR, "intent-model-v1.vocab.json");

const grammarDigest = createHash("sha256").update(toGbnfGrammar()).digest("hex");
if (grammarDigest !== manifest.grammarSha256.toLowerCase()) {
  throw new Error(
    `GRAMMAR DRIFT: manifest pins ${manifest.grammarSha256.slice(0, 12)}… but this build generates ${grammarDigest.slice(0, 12)}… — retrain (npm run intent-model:all)`,
  );
}

const modelBytes = readFileSync(modelPath);
const modelDigest = createHash("sha256").update(modelBytes).digest("hex");
if (modelDigest !== manifest.model.sha256.toLowerCase()) throw new Error("model hash mismatch");
if (modelBytes.byteLength !== manifest.model.bytes) throw new Error("model byte size mismatch");

const vocabBytes = readFileSync(vocabPath);
const vocab = JSON.parse(vocabBytes.toString("utf8")) as IntentModelVocab;
const vocabDigest = createHash("sha256").update(vocabBytes.toString("utf8")).digest("hex");
if (vocabDigest !== manifest.features.vocabSha256.toLowerCase()) throw new Error("vocab hash mismatch");
if (vocab.tokens.length !== manifest.features.vocabSize) throw new Error("vocab size mismatch");

const ortPackage = JSON.parse(
  readFileSync(path.join(ROOT, "node_modules", "onnxruntime-web", "package.json"), "utf8"),
) as {
  version?: string;
};
if (typeof ortPackage.version !== "string") throw new Error("onnxruntime-web package version is unavailable");

// Browser-compatible runtime on a node host — same pattern as
// validate-intent-ranker.mjs; the wasm binaries stay local node_modules.
const ort = await import("onnxruntime-web");
ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
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

const loadRows = (file: string): { bytes: Buffer; rows: Row[] } => {
  const bytes = readFileSync(path.join(DATA_DIR, file));
  const rows = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);
  return { bytes, rows };
};

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

function reportStats(stats: GateStats) {
  const perKind: Record<
    string,
    { rows: number; attempted: number; exact: number; wrongKind: number; abstain: number }
  > = {};
  for (const [kind, entry] of [...stats.perKind.entries()].sort()) perKind[kind] = { ...entry };
  return {
    rows: stats.rows,
    attempted: stats.attempted,
    exact: stats.exact,
    attemptedExactRate: rate(stats.exact, stats.attempted),
    wrongKind: stats.wrongKind,
    abstain: stats.abstain,
    abstainRate: rate(stats.abstain, stats.rows),
    perKind,
  };
}

function gateFailures(stats: GateStats, label: string): string[] {
  const failures: string[] = [];
  const attemptedExact = stats.attempted === 0 ? 0 : stats.exact / stats.attempted;
  const abstainRate = stats.abstain / Math.max(1, stats.rows);
  if (stats.wrongKind !== 0) failures.push(label + ": wrongKind=" + stats.wrongKind + " (must be 0)");
  if (attemptedExact < 0.95)
    failures.push(label + ": attemptedExact=" + (attemptedExact * 100).toFixed(1) + "% (< 95%)");
  if (abstainRate > 0.2) failures.push(label + ": abstainRate=" + (abstainRate * 100).toFixed(1) + "% (> 20%)");
  return failures;
}

function instructionKeys(rows: Row[]): Set<string> {
  return new Set(
    rows.map((row) => row.instruction.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US")),
  );
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let overlap = 0;
  for (const key of a) if (b.has(key)) overlap += 1;
  return overlap;
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
    const decoded = decodeIntentHeads(outputs, vocab, {
      kindMargin: KIND_MARGIN,
      abstainMargin: ABSTAIN_MARGIN,
    });
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

// Decode margins: defaults are the PRODUCTION pins (src/intent/model-decoder.ts).
// MARGIN / ABSTAIN_MARGIN envs exist for the gate re-eval sweeps
// (docs/INTENT-MINING-2026-09-30.md wave 3): a margin that clears
// wrongKind must ALSO become the production pin before this gate's
// gatePassed=true is meaningful for the runtime.
// Defaults mirror the PRODUCTION PINS (src/intent/model-decoder.ts) — one
// source of truth, so the gate always judges the runtime the browser gets.
const KIND_MARGIN = Number(process.env.MARGIN ?? INTENT_MODEL_KIND_MARGIN);
const ABSTAIN_MARGIN = Number(process.env.ABSTAIN_MARGIN ?? INTENT_MODEL_ABSTAIN_MARGIN);
if (KIND_MARGIN !== INTENT_MODEL_KIND_MARGIN || ABSTAIN_MARGIN !== INTENT_MODEL_ABSTAIN_MARGIN) {
  console.log(
    `[gate] running with NON-PRODUCTION margins: kindMargin=${KIND_MARGIN} abstainMargin=${ABSTAIN_MARGIN} ` +
      `(production pins are ${INTENT_MODEL_KIND_MARGIN} / ${INTENT_MODEL_ABSTAIN_MARGIN}) — if the gate passes, the pin flip must land in the same change`,
  );
}

const trainData = loadRows("train.jsonl");
const valData = loadRows("val.jsonl");
const goldenData = loadRows("golden.jsonl");
const trainRows = trainData.rows;
const valRows = valData.rows;
const goldenRows = goldenData.rows;
const datasetManifestPath = path.join(DATA_DIR, "manifest.json");
const datasetManifestBytes = readFileSync(datasetManifestPath);
const datasetManifest = JSON.parse(datasetManifestBytes.toString("utf8")) as {
  datasetVersion?: number;
  train?: number;
  val?: number;
  golden?: number;
};
if (
  datasetManifest.train !== trainRows.length ||
  datasetManifest.val !== valRows.length ||
  datasetManifest.golden !== goldenRows.length
) {
  throw new Error("intent SFT dataset manifest row counts do not match the split files");
}

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

const valFailures = gateFailures(valStats, "val");
const goldenFailures = gateFailures(goldenStats, "golden regression suite");
const productionMargins = KIND_MARGIN === INTENT_MODEL_KIND_MARGIN && ABSTAIN_MARGIN === INTENT_MODEL_ABSTAIN_MARGIN;
const allGateFailures = [...valFailures, ...goldenFailures];
if (!productionMargins) {
  allGateFailures.push("non-production decoder margins: exploratory results cannot set manifest gatePassed=true");
}
const releaseGatePassed = allGateFailures.length === 0;
const trainKeys = instructionKeys(trainRows);
const valKeys = instructionKeys(valRows);
const goldenKeys = instructionKeys(goldenRows);
const exactInstructionOverlap = {
  normalization: "NFKC + trim + collapse whitespace + lowercase (en-US)",
  trainVal: overlapCount(trainKeys, valKeys),
  trainGolden: overlapCount(trainKeys, goldenKeys),
  valGolden: overlapCount(valKeys, goldenKeys),
  goldenIsIndependentHoldout: false,
  candidateFamilyDisjointnessVerified: false,
};
const pinnedInputs = [
  { label: "model manifest", path: MANIFEST_PATH, sha256: sha256(manifestBytes) },
  { label: "ONNX model", path: modelPath, sha256: modelDigest },
  { label: "model vocabulary", path: vocabPath, sha256: vocabDigest },
  { label: "dataset manifest", path: datasetManifestPath, sha256: sha256(datasetManifestBytes) },
  { label: "train split", path: path.join(DATA_DIR, "train.jsonl"), sha256: sha256(trainData.bytes) },
  { label: "validation split", path: path.join(DATA_DIR, "val.jsonl"), sha256: sha256(valData.bytes) },
  { label: "golden split", path: path.join(DATA_DIR, "golden.jsonl"), sha256: sha256(goldenData.bytes) },
  { label: "validator source", path: VALIDATOR_SOURCE_PATH, sha256: sha256(validatorSourceBytes) },
  { label: "decoder source", path: MODEL_DECODER_PATH, sha256: sha256(decoderSourceBytes) },
  { label: "action schema source", path: MODEL_SCHEMA_PATH, sha256: sha256(schemaSourceBytes) },
];
for (const input of pinnedInputs) {
  if (sha256(readFileSync(input.path)) !== input.sha256) {
    throw new Error(
      input.label + " changed while evaluating; no report or gate verdict was written — rerun after edits settle",
    );
  }
}
const validationReport = {
  schemaVersion: 1,
  kind: "intent-action-model-validation",
  taskBoundary: "Closed-set action/slot decoding only; not a creative-brief or musical-quality evaluation.",
  generatedAt: new Date().toISOString(),
  model: {
    version: manifest.intentModelVersion,
    runtime: "onnxruntime-web@" + ortPackage.version + "/wasm",
    modelBytes: modelBytes.byteLength,
    modelSha256: modelDigest,
    vocabularySha256: vocabDigest,
    grammarSha256: grammarDigest,
    trainingReport: {
      trainRows: manifest.report?.["trainRows"] ?? null,
      valRows: manifest.report?.["valRows"] ?? null,
      goldenRows: manifest.report?.["goldenRows"] ?? null,
      valHeadAccuracyMean: manifest.report?.["valHeadAccuracyMean"] ?? null,
      trainingDataContentHashPinned: manifest.report?.["trainingDataContentHashPinned"] === true,
      trainingInputs: manifest.report?.["trainingInputs"] ?? null,
    },
  },
  evaluationDataset: {
    version: datasetManifest.datasetVersion ?? null,
    manifestSha256: sha256(datasetManifestBytes),
    splits: {
      train: { rows: trainRows.length, sha256: sha256(trainData.bytes) },
      val: { rows: valRows.length, sha256: sha256(valData.bytes) },
      golden: { rows: goldenRows.length, sha256: sha256(goldenData.bytes) },
    },
    exactInstructionOverlap,
    trainingReportRowCountsMatch:
      manifest.report?.["trainRows"] === trainRows.length &&
      manifest.report?.["valRows"] === valRows.length &&
      manifest.report?.["goldenRows"] === goldenRows.length,
  },
  evaluator: {
    validatorSha256: sha256(validatorSourceBytes),
    decoderSha256: sha256(decoderSourceBytes),
    schemaSourceSha256: sha256(schemaSourceBytes),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    executionProvider: "wasm",
    wasmThreads: 1,
  },
  decode: { kindMargin: KIND_MARGIN, abstainMargin: ABSTAIN_MARGIN, productionMargins },
  metrics: {
    train: reportStats(trainStats),
    val: reportStats(valStats),
    goldenRegressionSuite: reportStats(goldenStats),
  },
  gate: {
    criteria: { attemptedExactRateMin: 0.95, wrongKindMax: 0, abstainRateMax: 0.2 },
    valPassed: valFailures.length === 0,
    goldenRegressionSuitePassed: goldenFailures.length === 0,
    determinismPassed: true,
    deterministicValRows: Math.min(16, valRows.length),
    releaseGateEligible: productionMargins,
    passed: releaseGatePassed,
    failures: allGateFailures,
  },
  claims: {
    actionIntentOnly: true,
    independentGeneralizationEvidence: false,
    musicalQualityEvidence: false,
  },
};
const validationReportBytes = Buffer.from(JSON.stringify(validationReport, null, 2) + "\n", "utf8");
writeFileSync(VALIDATION_REPORT_PATH, validationReportBytes);
console.log(
  "exact-instruction overlap: train↔val=" +
    exactInstructionOverlap.trainVal +
    ", train↔golden=" +
    exactInstructionOverlap.trainGolden +
    ", val↔golden=" +
    exactInstructionOverlap.valGolden +
    "; golden is a regression suite, not an independent holdout",
);
console.log(
  `train attemptedExact=${((trainStats.exact / Math.max(1, trainStats.attempted)) * 100).toFixed(1)}% (informational, not gated)`,
);
// Gate passed — pin the verdict into the manifest so the loader may
// register this artifact (read → patch → write, pins untouched).
const manifestPath = path.join(MODELS_DIR, "intent-model-v1.manifest.json");
const patched = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
patched.report = {
  ...patched.report,
  gatePassed: releaseGatePassed,
  validationReportPath: "scripts/data/intent-model-validation-report.json",
  validationReportSha256: sha256(validationReportBytes),
};
if (!isIntentModelManifest(patched)) throw new Error("patched manifest malformed — refusing to write");
writeFileSync(
  manifestPath,
  `${JSON.stringify(patched, null, 2)}
`,
);
if (!releaseGatePassed) {
  if (valFailures.length > 0) checkGate(valStats, "val");
  if (goldenFailures.length > 0) checkGate(goldenStats, "golden regression suite");
  throw new Error(
    "RELEASE GATE FAILED — " +
      allGateFailures.join("; ") +
      "; report saved to scripts/data/intent-model-validation-report.json",
  );
}
console.log(
  "RELEASE GATE PASSED — attempted-exact >= 95%, wrongKind = 0, abstain <= 20% on val + golden regression suite; " +
    "manifest gatePassed=true",
);
