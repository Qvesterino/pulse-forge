/**
 * Compares an isolated intent-model challenger with the active browser model
 * on the current validation and golden regression splits. It never edits the
 * active manifest or promotes a candidate. These legacy splits are not an
 * independent release holdout, so this report is diagnostic only.
 *
 * Run: npx vite-node scripts/evaluate-intent-model-candidate.mts --candidate .sft/intent-model-challenger [--out <path>]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import {
  buildIntentBow,
  canonicalModelJson,
  decodeIntentHeads,
  type IntentModelVocab,
} from "../src/intent/model-decoder";
import { INTENT_MODEL_ABSTAIN_MARGIN, INTENT_MODEL_KIND_MARGIN } from "../src/intent/model-decoder";
import { isIntentModelManifest } from "../src/intent/model-loader-types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "scripts", "data", "intent-sft");
const ACTIVE_DIR = path.join(ROOT, "public", "models");
const CANDIDATE_INDEX = process.argv.indexOf("--candidate");
if (CANDIDATE_INDEX < 0 || !process.argv[CANDIDATE_INDEX + 1]) {
  throw new Error(
    "usage: npx vite-node scripts/evaluate-intent-model-candidate.mts --candidate <artifact-dir> [--out <path>]",
  );
}
const CANDIDATE_DIR = path.resolve(ROOT, process.argv[CANDIDATE_INDEX + 1]);
const OUTPUT_INDEX = process.argv.indexOf("--out");

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const readJson = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const normalizeInstruction = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");

interface Row {
  instruction: string;
  lang?: string;
  response: unknown;
}

interface SliceStats {
  rows: number;
  attempted: number;
  exact: number;
  wrongKind: number;
  slotMismatch: number;
  abstain: number;
}

interface Stats extends SliceStats {
  perKind: Map<string, SliceStats>;
  perLanguage: Map<string, SliceStats>;
}

function loadRows(file: string): { bytes: Buffer; rows: Row[] } {
  const bytes = readFileSync(path.join(DATA_DIR, file));
  const rows = bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const value = JSON.parse(line) as unknown;
      if (value == null || typeof value !== "object") throw new Error(`${file}:${index + 1}: expected an object`);
      const row = value as Partial<Row>;
      if (typeof row.instruction !== "string" || row.instruction.trim().length === 0 || !("response" in row)) {
        throw new Error(`${file}:${index + 1}: missing instruction/response`);
      }
      return row as Row;
    });
  return { bytes, rows };
}

function emptyStats(): Stats {
  return {
    rows: 0,
    attempted: 0,
    exact: 0,
    wrongKind: 0,
    slotMismatch: 0,
    abstain: 0,
    perKind: new Map(),
    perLanguage: new Map(),
  };
}

function bucket(map: Map<string, SliceStats>, key: string): SliceStats {
  const value = map.get(key) ?? { rows: 0, attempted: 0, exact: 0, wrongKind: 0, slotMismatch: 0, abstain: 0 };
  map.set(key, value);
  return value;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function summarizeSlice(stats: SliceStats) {
  return {
    rows: stats.rows,
    attempted: stats.attempted,
    coverageRate: rate(stats.attempted, stats.rows),
    exact: stats.exact,
    exactRate: rate(stats.exact, stats.rows),
    attemptedExactRate: rate(stats.exact, stats.attempted),
    wrongKind: stats.wrongKind,
    slotMismatch: stats.slotMismatch,
    abstain: stats.abstain,
    abstainRate: rate(stats.abstain, stats.rows),
  };
}

function reportStats(stats: Stats) {
  return {
    ...summarizeSlice(stats),
    perKind: Object.fromEntries(
      [...stats.perKind.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarizeSlice(v)]),
    ),
    perLanguage: Object.fromEntries(
      [...stats.perLanguage.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarizeSlice(v)]),
    ),
  };
}

async function openModel(directory: string, label: string) {
  const modelPath = path.join(directory, "intent-model-v1.onnx");
  const vocabPath = path.join(directory, "intent-model-v1.vocab.json");
  const modelBytes = readFileSync(modelPath);
  const vocabBytes = readFileSync(vocabPath);
  const vocab = JSON.parse(vocabBytes.toString("utf8")) as IntentModelVocab;
  if (!Array.isArray(vocab.tokens) || !Array.isArray(vocab.heads) || vocab.heads.length === 0) {
    throw new Error(`${label} has malformed vocabulary artifact`);
  }
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  if (session.inputNames[0] !== "features") throw new Error(`${label} input must be named features`);
  for (const head of vocab.heads) {
    if (!session.outputNames.includes(`head_${head.name}`))
      throw new Error(`${label} graph is missing head_${head.name}`);
  }
  return { label, modelBytes, vocabBytes, vocab, session };
}

async function evaluate(model: Awaited<ReturnType<typeof openModel>>, rows: Row[], label: string) {
  const stats = emptyStats();
  for (const row of rows) {
    stats.rows++;
    const expected = row.response as { kind?: string } | null;
    const expectedKind = String(expected?.kind ?? "unknown");
    const kindStats = bucket(stats.perKind, expectedKind);
    const langStats = bucket(stats.perLanguage, row.lang ?? "unknown");
    kindStats.rows++;
    langStats.rows++;
    const bow = buildIntentBow(row.instruction, model.vocab.tokens);
    const tensor = new ort.Tensor("float32", bow, [1, bow.length]);
    const feeds: Record<string, typeof tensor> = { features: tensor };
    const results = (await model.session.run(feeds)) as Record<string, { data: Float32Array }>;
    const outputs: Record<string, Float32Array> = {};
    for (const head of model.vocab.heads) {
      const result = results[`head_${head.name}`];
      if (!result) throw new Error(`${model.label} returned no head_${head.name}`);
      outputs[`head_${head.name}`] = result.data;
    }
    const decoded = decodeIntentHeads(outputs, model.vocab, {
      kindMargin: INTENT_MODEL_KIND_MARGIN,
      abstainMargin: INTENT_MODEL_ABSTAIN_MARGIN,
    });
    if (decoded === null) {
      stats.abstain++;
      kindStats.abstain++;
      langStats.abstain++;
      continue;
    }
    stats.attempted++;
    kindStats.attempted++;
    langStats.attempted++;
    if (expected === null || decoded.kind !== expectedKind) {
      stats.wrongKind++;
      kindStats.wrongKind++;
      langStats.wrongKind++;
    } else if (canonicalModelJson(decoded) === canonicalModelJson(expected)) {
      stats.exact++;
      kindStats.exact++;
      langStats.exact++;
    } else {
      stats.slotMismatch++;
      kindStats.slotMismatch++;
      langStats.slotMismatch++;
    }
  }
  console.log(
    `[${model.label} / ${label}] exact=${stats.exact}/${stats.rows} ` +
      `coverage=${((stats.attempted / Math.max(1, stats.rows)) * 100).toFixed(1)}% ` +
      `attemptedExact=${((stats.exact / Math.max(1, stats.attempted)) * 100).toFixed(1)}% ` +
      `wrongKind=${stats.wrongKind} slotMismatch=${stats.slotMismatch} abstain=${stats.abstain}`,
  );
  for (const [language, entry] of [...stats.perLanguage.entries()].sort()) {
    console.log(
      `    ${language}: exact=${entry.exact}/${entry.rows} coverage=${((entry.attempted / Math.max(1, entry.rows)) * 100).toFixed(1)}% ` +
        `wrongKind=${entry.wrongKind} slotMismatch=${entry.slotMismatch} abstain=${entry.abstain}`,
    );
  }
  return reportStats(stats);
}

ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
ort.env.wasm.numThreads = 1;

const train = loadRows("train.jsonl");
const validation = loadRows("val.jsonl");
const golden = loadRows("golden.jsonl");
const candidateReport = readJson<{
  trainingInputs?: Record<string, string | number>;
}>(path.join(CANDIDATE_DIR, "intent-model-report.json"));
if (!candidateReport.trainingInputs) throw new Error("candidate report has no training snapshot hashes");
const currentTrainingInputs = {
  datasetVersion: readJson<{ datasetVersion?: number }>(path.join(DATA_DIR, "manifest.json")).datasetVersion,
  datasetManifestSha256: sha256(readFileSync(path.join(DATA_DIR, "manifest.json"))),
  trainSha256: sha256(train.bytes),
  valSha256: sha256(validation.bytes),
  goldenSha256: sha256(golden.bytes),
  trainerSha256: sha256(readFileSync(path.join(ROOT, "scripts", "train-intent-model.py"))),
};
if (JSON.stringify(candidateReport.trainingInputs) !== JSON.stringify(currentTrainingInputs)) {
  throw new Error("candidate was not trained from the exact current dataset/trainer snapshot");
}

const activeManifest = readJson<unknown>(path.join(ACTIVE_DIR, "intent-model-v1.manifest.json"));
if (!isIntentModelManifest(activeManifest)) throw new Error("active model manifest is malformed");
const activeModel = await openModel(ACTIVE_DIR, "active");
const activeModelHash = sha256(activeModel.modelBytes);
if (activeManifest.model.sha256.toLowerCase() !== activeModelHash)
  throw new Error("active model hash does not match manifest");
const candidate = await openModel(CANDIDATE_DIR, "candidate");

const trainKeys = new Set(train.rows.map((row) => normalizeInstruction(row.instruction)));
const validationKeys = new Set(validation.rows.map((row) => normalizeInstruction(row.instruction)));
const goldenKeys = new Set(golden.rows.map((row) => normalizeInstruction(row.instruction)));
const overlaps = {
  trainVal: [...trainKeys].filter((key) => validationKeys.has(key)).length,
  trainGolden: [...trainKeys].filter((key) => goldenKeys.has(key)).length,
  valGolden: [...validationKeys].filter((key) => goldenKeys.has(key)).length,
};

const metrics = {
  active: {
    val: await evaluate(activeModel, validation.rows, "val"),
    goldenRegressionSuite: await evaluate(activeModel, golden.rows, "golden"),
  },
  candidate: {
    val: await evaluate(candidate, validation.rows, "val"),
    goldenRegressionSuite: await evaluate(candidate, golden.rows, "golden"),
  },
};
const report = {
  schemaVersion: 1,
  kind: "intent-model-candidate-comparison",
  generatedAt: new Date().toISOString(),
  promotionEligible: false,
  limitation: "Current validation and golden splits are not an independent family-disjoint release holdout.",
  currentSplitOverlap: overlaps,
  environment: { runtime: "onnxruntime-web", executionProvider: "wasm", wasmThreads: 1, platform: process.platform },
  artifacts: {
    active: {
      modelSha256: activeModelHash,
      modelBytes: activeModel.modelBytes.byteLength,
      vocabSha256: sha256(activeModel.vocabBytes),
    },
    candidate: {
      modelSha256: sha256(candidate.modelBytes),
      modelBytes: candidate.modelBytes.byteLength,
      vocabSha256: sha256(candidate.vocabBytes),
      trainingInputs: candidateReport.trainingInputs,
    },
  },
  metrics,
};

if (OUTPUT_INDEX >= 0) {
  const output = process.argv[OUTPUT_INDEX + 1];
  if (!output) throw new Error("--out requires a path");
  const outputPath = path.resolve(ROOT, output);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`candidate comparison report written: ${path.relative(ROOT, outputPath)}`);
}
