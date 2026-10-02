import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileBriefContract } from "../src/intent/brief-contract";
import {
  createCreativeTaskRequestV1,
  validateCreativeTaskOutput,
  type CreativeTaskRequestV1,
} from "../src/intent/creative-task-contract";
import { evaluateCreativeTaskPredictions, type CreativeTaskGoldenCaseV1 } from "../src/intent/creative-task-evaluation";
import {
  createCreativeTaskOllamaProvider,
  creativeTaskOllamaSystemPrompt,
  type CreativeTaskProviderError,
} from "../src/intent/creative-task-ollama";
import { parseIntentText } from "../src/intent/text-parser";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const GOLDEN_PATH = path.resolve("scripts/data/creative-task-v1-golden.jsonl");
const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJsonl(filePath: string): { rows: unknown[]; bytes: Buffer } {
  const bytes = readFileSync(filePath);
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes: ${filePath}`);
  const rows: unknown[] = [];
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
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
  const golden: CreativeTaskGoldenCaseV1[] = [];
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
    golden.push({
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
  if (golden.length === 0) throw new Error("Creative-task golden set is empty.");
  if (new Set(golden.map((entry) => entry.id)).size !== golden.length)
    throw new Error("Duplicate golden ids detected.");
  return golden;
}

async function localModelMetadata(model: string): Promise<{ name: string; digest: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(OLLAMA_TAGS_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama tags request failed (${response.status}).`);
    const payload: unknown = await response.json();
    if (!record(payload) || !Array.isArray(payload.models))
      throw new Error("Ollama returned an invalid tags response.");
    const match = payload.models.find(
      (entry: unknown) =>
        record(entry) && typeof entry.name === "string" && (entry.name === model || entry.name.startsWith(`${model}:`)),
    );
    if (!record(match) || typeof match.name !== "string") throw new Error(`Ollama model is not installed: ${model}`);
    return { name: match.name, digest: typeof match.digest === "string" ? match.digest : null };
  } finally {
    clearTimeout(timer);
  }
}

function makeRequest(entry: CreativeTaskGoldenCaseV1): CreativeTaskRequestV1 {
  const parsed = parseIntentText(entry.prompt);
  const result = createCreativeTaskRequestV1({
    operation: entry.operation,
    prompt: entry.prompt,
    intent: parsed.input,
    contract: compileBriefContract(parsed),
  });
  if (!result.ok) throw new Error(`Could not build request for ${entry.id}: ${result.reason}`);
  return result.request;
}

function cliValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function sourceHash(relativePath: string): string {
  return sha256(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url))));
}

try {
  const args = process.argv.slice(2);
  const modelArg = cliValue(args, "--model");
  const predictionsArg = cliValue(args, "--predictions-out");
  const reportArg = cliValue(args, "--report-out");
  const limitArg = cliValue(args, "--limit");
  const allowed = [
    "--model",
    modelArg,
    "--predictions-out",
    predictionsArg,
    "--report-out",
    reportArg,
    "--limit",
    limitArg,
  ];
  if (!modelArg || !predictionsArg || !reportArg || args.some((arg) => !allowed.includes(arg))) {
    throw new Error(
      "Usage: npx vite-node scripts/evaluate-creative-task-ollama.mts --model <ollama-tag> --predictions-out <predictions.jsonl> --report-out <report.json> [--limit <1..21>]",
    );
  }

  const goldenFile = readJsonl(GOLDEN_PATH);
  const golden = parseGolden(goldenFile.rows);
  const limit = limitArg === null ? golden.length : Number(limitArg);
  if (!Number.isInteger(limit) || limit < 1 || limit > golden.length) {
    throw new Error(`--limit must be an integer from 1 to ${golden.length}.`);
  }
  const evaluationCases = golden.slice(0, limit);
  const model = await localModelMetadata(modelArg);
  // Evaluation may cold-load a local multi-gigabyte model; production callers
  // can choose the shorter provider default when they surface this capability.
  const provider = createCreativeTaskOllamaProvider({
    model: model.name,
    timeoutMs: 120_000,
    unloadAfterRequest: evaluationCases.length === 1,
  });
  const predictions: Array<{ id: string; output: unknown }> = [];
  const providerFailures: Array<{ id: string; error: CreativeTaskProviderError; outputError?: string }> = [];

  for (const [index, entry] of evaluationCases.entries()) {
    process.stderr.write(`[${index + 1}/${evaluationCases.length}] ${entry.id}: requesting\n`);
    const result = await provider.interpret(makeRequest(entry));
    if (result.ok) {
      predictions.push({ id: entry.id, output: result.output });
      process.stderr.write(`[${index + 1}/${evaluationCases.length}] ${entry.id}: valid output\n`);
    } else {
      // Keep malformed model completions as invalid rows, but do not fabricate
      // a prediction for timeouts, transport errors, or circuit-open skips.
      if (result.error === "invalid-output") predictions.push({ id: entry.id, output: null });
      const outputError = result.error === "invalid-output" ? result.outputError : undefined;
      providerFailures.push({ id: entry.id, error: result.error, ...(outputError ? { outputError } : {}) });
      process.stderr.write(
        `[${index + 1}/${evaluationCases.length}] ${entry.id}: ${result.error}${outputError ? ` (${outputError})` : ""}\n`,
      );
    }
  }

  const predictionBytes = Buffer.from(`${predictions.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const predictionPath = path.resolve(predictionsArg);
  const reportPath = path.resolve(reportArg);
  if (predictionPath === reportPath || predictionPath === GOLDEN_PATH || reportPath === GOLDEN_PATH) {
    throw new Error("Prediction, report and golden paths must be distinct.");
  }
  const report = {
    reportVersion: 1,
    taskBoundary: "creative brief interpretation only; not musical-quality evaluation",
    provider: {
      kind: "local-ollama",
      id: provider.id,
      version: provider.version,
      model: model.name,
      modelDigest: model.digest,
      promptSha256: sha256(creativeTaskOllamaSystemPrompt()),
    },
    dataset: {
      path: path.relative(process.cwd(), GOLDEN_PATH),
      sha256: sha256(goldenFile.bytes),
      cases: golden.length,
      requestedCases: evaluationCases.length,
      completeRun: evaluationCases.length === golden.length,
      split: "synthetic-held-out",
    },
    sources: {
      providerSha256: sourceHash("../src/intent/creative-task-ollama.ts"),
      runnerSha256: sourceHash("./evaluate-creative-task-ollama.mts"),
      contractSha256: sourceHash("../src/intent/creative-task-contract.ts"),
      evaluatorSha256: sourceHash("../src/intent/creative-task-evaluation.ts"),
      parserSha256: sourceHash("../src/intent/text-parser.ts"),
      briefCompilerSha256: sourceHash("../src/intent/brief-contract.ts"),
    },
    predictions: {
      path: path.relative(process.cwd(), predictionPath),
      sha256: sha256(predictionBytes),
      count: predictions.length,
      providerFailures,
    },
    evaluation: evaluateCreativeTaskPredictions(golden, predictions),
  };

  writeFileSync(predictionPath, predictionBytes);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ model: model.name, digest: model.digest, cases: golden.length, requestedCases: evaluationCases.length, completeRun: evaluationCases.length === golden.length, failures: providerFailures.length, report: reportPath })}\n`,
    () => process.exit(0),
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(2));
}
