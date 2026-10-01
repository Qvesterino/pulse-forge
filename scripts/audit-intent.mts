/**
 * INTENT FAILURE MINER (scratch, library-gate wave follow-up) — runs the
 * trained ONNX intent head over the val split and dumps per-kind stats plus
 * every failed row (instruction, teacher action, decoded action, slot diff).
 * Scratch tooling: no manifest writes, no gate decisions.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildIntentBow,
  canonicalModelJson,
  decodeIntentHeads,
  type IntentModelVocab,
} from "../src/intent/model-decoder";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = path.join(ROOT, "public", "models");

const manifest = JSON.parse(readFileSync(path.join(MODELS_DIR, "intent-model-v1.manifest.json"), "utf8"));
const vocab = JSON.parse(readFileSync(path.join(MODELS_DIR, "intent-model-v1.vocab.json"), "utf8")) as IntentModelVocab;
const modelBytes = readFileSync(path.join(MODELS_DIR, "intent-model-v1.onnx"));

const ort = await import("onnxruntime-web");
ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});

let MARGIN = 1.0;
let ABSTAIN = 2.0;
async function infer(instruction: string): Promise<Record<string, Float32Array>> {
  const bow = buildIntentBow(instruction, vocab.tokens);
  const results = (await session.run({ features: new ort.Tensor("float32", bow, [1, bow.length]) })) as Record<
    string,
    { data: Float32Array }
  >;
  const outputs: Record<string, Float32Array> = {};
  for (const name of manifest.features.outputNames) outputs[name] = results[name].data;
  return outputs;
}

MARGIN = Number(process.env.MARGIN ?? 1.0);
ABSTAIN = Number(process.env.ABSTAIN_MARGIN ?? 2.0);
const rows = readFileSync(path.join(ROOT, "scripts", "data", "intent-sft", "val.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

interface Fail {
  instruction: string;
  trueKind: string;
  gotKind: string;
  kind: "abstain" | "wrongKind" | "wrongSlots";
  slotDiff?: string;
  lang: string;
}

const perKind = new Map<string, { rows: number; attempted: number; exact: number }>();
let wrongKindCount = 0;
const fails: Fail[] = [];

for (const row of rows) {
  const truth = row.response;
  const trueKind = String(truth.kind);
  const bucket = perKind.get(trueKind) ?? { rows: 0, attempted: 0, exact: 0 };
  bucket.rows += 1;
  const outputs = await infer(row.instruction);
  const decoded = decodeIntentHeads(outputs, vocab, { kindMargin: MARGIN, abstainMargin: ABSTAIN });
  if (decoded === null) {
    bucket.rows += 0;
    fails.push({ instruction: row.instruction, trueKind, gotKind: "abstain", kind: "abstain", lang: row.lang });
    perKind.set(trueKind, bucket);
    continue;
  }
  bucket.attempted += 1;
  const gotKind = String(decoded.kind);
  const wantJson = canonicalModelJson(truth);
  const gotJson = canonicalModelJson(decoded);
  if (wantJson === gotJson) {
    bucket.exact += 1;
  } else {
    if (gotKind !== trueKind) wrongKindCount += 1;
    // slot-level diff on JSON keys
    const want = (JSON.parse(wantJson) ?? {}) as Record<string, unknown>;
    const got = (JSON.parse(gotJson) ?? {}) as Record<string, unknown>;
    const diffs: string[] = [];
    for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const a = JSON.stringify(want[key]);
      const b = JSON.stringify(got[key]);
      if (a !== b) diffs.push(`${key}: ${a} → ${b}`);
    }
    fails.push({
      instruction: row.instruction,
      trueKind,
      gotKind,
      kind: gotKind !== trueKind ? "wrongKind" : "wrongSlots",
      slotDiff: diffs.join(" | "),
      lang: row.lang,
    });
  }
  perKind.set(trueKind, bucket);
}

let attempted = 0;
let exact = 0;
let abstain = 0;
for (const b of perKind.values()) {
  attempted += b.attempted;
  exact += b.exact;
}
abstain = rows.length - attempted;
console.log(
  `val rows=${rows.length} attempted=${attempted} exact=${exact} (attempted-exact=${((exact / Math.max(1, attempted)) * 100).toFixed(1)}%) abstain=${abstain} (${((abstain / rows.length) * 100).toFixed(1)}%) wrongKind=${wrongKindCount}`,
);
console.log("\nper-kind (sorted by failures):");
const sorted = [...perKind.entries()].sort((a, b) => b[1].rows - b[1].rows - (b[1].exact - a[1].exact));
for (const [kind, b] of sorted) {
  if (b.exact === b.rows) continue;
  console.log(
    `  ${kind.padEnd(14)} rows=${String(b.rows).padStart(3)} attempted=${String(b.attempted).padStart(3)} exact=${String(b.exact).padStart(3)}`,
  );
}
console.log(`\nfailures (${fails.length}):`);
for (const f of fails) {
  console.log(
    `  [${f.kind}] (${f.lang}) "${f.instruction}"  ${f.trueKind} → ${f.gotKind}${f.slotDiff ? `  ${f.slotDiff}` : ""}`,
  );
}
