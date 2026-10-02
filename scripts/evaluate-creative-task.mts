import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  evaluateCreativeTaskPredictions,
  type CreativeTaskGoldenCaseV1,
  type CreativeTaskPredictionV1,
} from "../src/intent/creative-task-evaluation";
import { validateCreativeTaskOutput } from "../src/intent/creative-task-contract";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const GOLDEN_PATH = path.resolve("scripts/data/creative-task-v1-golden.jsonl");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonl(filePath: string): { rows: unknown[]; bytes: Buffer } {
  const bytes = readFileSync(filePath);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes: ${filePath}`);
  const source = bytes.toString("utf8");
  const rows: unknown[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch {
      throw new Error(`Invalid JSON at ${filePath}:${index + 1}`);
    }
  }
  return { rows, bytes };
}

function parseGolden(rows: readonly unknown[]): CreativeTaskGoldenCaseV1[] {
  const result: CreativeTaskGoldenCaseV1[] = [];
  for (const [index, row] of rows.entries()) {
    if (
      !record(row) ||
      row.version !== 1 ||
      typeof row.id !== "string" ||
      typeof row.family !== "string" ||
      (row.language !== "en" && row.language !== "sk") ||
      row.split !== "held-out" ||
      (row.operation !== "generate" && row.operation !== "revise") ||
      typeof row.prompt !== "string"
    ) {
      throw new Error(`Invalid creative-task golden row ${index + 1}`);
    }
    const expected = validateCreativeTaskOutput(row.expected);
    if (!expected.ok) throw new Error(`Invalid expected output in golden row ${index + 1}: ${expected.error}`);
    result.push({
      version: 1,
      id: row.id,
      family: row.family,
      language: row.language,
      split: "held-out",
      operation: row.operation,
      prompt: row.prompt,
      expected: expected.output,
    });
  }
  if (result.length === 0) throw new Error("Creative-task golden set is empty.");
  if (new Set(result.map((row) => row.id)).size !== result.length) throw new Error("Duplicate golden ids detected.");
  return result;
}

function parsePredictions(rows: readonly unknown[]): CreativeTaskPredictionV1[] {
  return rows.map((row, index) => {
    if (!record(row) || typeof row.id !== "string" || !Object.prototype.hasOwnProperty.call(row, "output")) {
      throw new Error(`Invalid prediction row ${index + 1}; expected { id, output }.`);
    }
    return { id: row.id, output: row.output };
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cliValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

try {
  const args = process.argv.slice(2);
  const predictionArg = cliValue(args, "--predictions");
  const outputArg = cliValue(args, "--out");
  if (!predictionArg || args.some((arg) => !["--predictions", predictionArg, "--out", outputArg].includes(arg))) {
    throw new Error(
      "Usage: npx vite-node scripts/evaluate-creative-task.mts --predictions <jsonl> [--out <report.json>]",
    );
  }

  const predictionPath = path.resolve(predictionArg);
  const goldenFile = readJsonl(GOLDEN_PATH);
  const predictionsFile = readJsonl(predictionPath);
  const golden = parseGolden(goldenFile.rows);
  const predictions = parsePredictions(predictionsFile.rows);
  const report = {
    provenance: {
      evaluatorVersion: 1,
      goldenPath: path.relative(process.cwd(), GOLDEN_PATH),
      goldenSha256: sha256(goldenFile.bytes),
      predictionsPath: path.relative(process.cwd(), predictionPath),
      predictionsSha256: sha256(predictionsFile.bytes),
    },
    evaluation: evaluateCreativeTaskPredictions(golden, predictions),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputArg) writeFileSync(path.resolve(outputArg), serialized, "utf8");
  else process.stdout.write(serialized);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
