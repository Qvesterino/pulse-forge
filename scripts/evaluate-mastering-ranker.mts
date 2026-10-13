import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateMasteringRanker } from "../src/mastering/evaluation";
import { isMasteringRankerEvaluationGate } from "../src/mastering/ranker-types";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function usage(): string {
  return [
    "Usage: npm run mastering-ranker:evaluate -- --dataset <blind-set.json> --predictions <model-predictions.json> --runtime-measurement <runtime.json> --report-out <report.json> --report-asset-path /models/<report.json>",
    "The command reads local JSON only, requires a hash-bound Chromium/WASM runtime measurement, writes an aggregate report, and prints a manifest evaluation gate candidate.",
  ].join("\n");
}

async function readJson(path: string): Promise<{ value: unknown; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`${path}: input must be between 1 byte and ${MAX_INPUT_BYTES} bytes.`);
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, bytes };
  } catch {
    throw new Error(`${path}: invalid JSON.`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const datasetPath = option("--dataset");
  const predictionsPath = option("--predictions");
  const runtimeMeasurementPath = option("--runtime-measurement");
  const reportOut = option("--report-out");
  const reportAssetPath = option("--report-asset-path");
  if (!datasetPath || !predictionsPath || !runtimeMeasurementPath || !reportOut || !reportAssetPath)
    throw new Error(usage());

  const [datasetFile, predictionsFile, runtimeMeasurementFile] = await Promise.all([
    readJson(datasetPath),
    readJson(predictionsPath),
    readJson(runtimeMeasurementPath),
  ]);
  const datasetHash = createHash("sha256").update(datasetFile.bytes).digest("hex");
  const runtimeMeasurementHash = createHash("sha256").update(runtimeMeasurementFile.bytes).digest("hex");
  const report = evaluateMasteringRanker(
    datasetFile.value,
    predictionsFile.value,
    datasetHash,
    runtimeMeasurementFile.value,
    runtimeMeasurementHash,
  );
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportHash = createHash("sha256").update(reportText, "utf8").digest("hex");
  const reportPath = resolve(reportOut);
  await writeFile(reportPath, reportText, "utf8");

  const gate = {
    schemaVersion: 2,
    modelHash: report.modelHash,
    datasetHash: report.datasetHash,
    runtimeMeasurementHash: report.runtimeMeasurementHash,
    split: report.split,
    pairCount: report.pairCount,
    reviewerCodeCount: report.reviewerCodeCount,
    genreBucketCount: report.genreBucketCount,
    modelPreferenceRate: report.modelPreferenceRate,
    deterministicPreferenceRate: report.deterministicPreferenceRate,
    lower95Delta: report.lower95Delta,
    safetyRegressionCount: report.safetyRegressionCount,
    p95InferenceMs: report.p95InferenceMs,
    peakMemoryMiB: report.peakMemoryMiB,
    reportPath: reportAssetPath,
    reportHash,
  };
  const activationEligible = isMasteringRankerEvaluationGate(gate);
  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath,
        reportAssetPath,
        reportHash,
        activationEligible,
        evaluationGateCandidate: gate,
      },
      null,
      2,
    )}\n`,
  );
  if (!activationEligible) process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
