/**
 * INTENT FAILURE MINER (failure-mining wave, 2026-10-01) — runs the trained
 * ONNX intent head over a corpus split and reports per-kind stats plus every
 * failed row (instruction, teacher action, decoded action, slot diff).
 *
 * This is the measurement half of the mining loop (docs/INTENT-MINING-2026-09-30.md):
 * failures feed corpus waves and decoder calibration. Honest by contract:
 * NO manifest writes, NO gate decisions — the gate stays with the trainer.
 *
 * Usage (vite-node — app imports resolve through the vite root):
 *   npm run intent:mine                          # val split, console report
 *   npm run intent:mine -- --split train         # other split
 *   npm run intent:mine -- --json out.jsonl      # machine-readable failures
 *   MARGIN=0.8 ABSTAIN_MARGIN=1.5 npm run intent:mine   # decoder sweeps
 */
import { readFileSync, writeFileSync } from "node:fs";
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

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const SPLIT = argValue("--split") ?? "val";
const JSON_OUT = argValue("--json");
const Splits = ["train", "val", "golden"] as const;
if (!(Splits as readonly string[]).includes(SPLIT)) {
  throw new Error(`unknown split "${SPLIT}" (use ${Splits.join(", ")})`);
}

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

const MARGIN = Number(process.env.MARGIN ?? 1.0);
const ABSTAIN_MARGIN = Number(process.env.ABSTAIN_MARGIN ?? 2.0);

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

interface Fail {
  instruction: string;
  trueKind: string;
  gotKind: string;
  kind: "abstain" | "wrongKind" | "wrongSlots";
  slotDiff?: string;
  lang: string;
}

interface SplitRow {
  instruction: string;
  lang: string;
  response: Record<string, unknown>;
}

const rows: SplitRow[] = readFileSync(path.join(ROOT, "scripts", "data", "intent-sft", `${SPLIT}.jsonl`), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

const perKind = new Map<string, { rows: number; attempted: number; exact: number }>();
let wrongKindCount = 0;
const fails: Fail[] = [];

for (const row of rows) {
  const truth = row.response;
  const trueKind = String(truth.kind);
  const bucket = perKind.get(trueKind) ?? { rows: 0, attempted: 0, exact: 0 };
  bucket.rows += 1;
  const outputs = await infer(row.instruction);
  const decoded = decodeIntentHeads(outputs, vocab, { kindMargin: MARGIN, abstainMargin: ABSTAIN_MARGIN });
  if (decoded === null) {
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
for (const b of perKind.values()) {
  attempted += b.attempted;
  exact += b.exact;
}
const abstain = rows.length - attempted;
console.log(
  `[${SPLIT}] margin=${MARGIN} abstainMargin=${ABSTAIN_MARGIN} rows=${rows.length} attempted=${attempted} exact=${exact} (attempted-exact=${((exact / Math.max(1, attempted)) * 100).toFixed(1)}%) abstain=${abstain} (${((abstain / rows.length) * 100).toFixed(1)}%) wrongKind=${wrongKindCount}`,
);
console.log("\nper-kind (sorted by failures):");
const sorted = [...perKind.entries()].sort((a, b) => b[1].rows - b[1].rows - (b[1].exact - a[1].exact));
for (const [kind, b] of sorted) {
  if (b.exact === b.rows) continue;
  console.log(
    `  ${kind.padEnd(14)} rows=${String(b.rows).padStart(3)} attempted=${String(b.attempted).padStart(3)} exact=${String(b.exact).padStart(3)}`,
  );
}
const wrongKindFails = fails.filter((f) => f.kind === "wrongKind");
if (wrongKindFails.length > 0) {
  console.log(`\nwrongKind failures (gate-hard-zero list):`);
  for (const f of wrongKindFails) {
    console.log(`  (${f.lang}) "${f.instruction}"  ${f.trueKind} → ${f.gotKind}`);
  }
}
console.log(`\nfailures (${fails.length}):`);
for (const f of fails) {
  console.log(
    `  [${f.kind}] (${f.lang}) "${f.instruction}"  ${f.trueKind} → ${f.gotKind}${f.slotDiff ? `  ${f.slotDiff}` : ""}`,
  );
}

if (JSON_OUT) {
  const outPath = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(ROOT, JSON_OUT);
  writeFileSync(outPath, fails.map((f) => JSON.stringify(f)).join("\n") + "\n");
  console.log(`\nwrote ${fails.length} failures → ${outPath}`);
}
