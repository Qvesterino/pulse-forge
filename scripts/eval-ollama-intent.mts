/**
 * LIVE EVAL — runs VAL corpus rows through the Ollama intent provider and
 * scores assembled exact/kindOK against the teacher (same yardstick as
 * validate-intent-model.mts). The pre/post-SFT comparison instrument:
 *
 *   baseline:  npx vite-node scripts/eval-ollama-intent.mts
 *   SFT model: npx vite-node scripts/eval-ollama-intent.mts --model kyx-intent-sft
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ollamaIntentModel,
  setOllamaIntentModel,
  setOllamaIntentModeOverride,
  ensureOllamaIntentProvider,
} from "../src/intent/model-ollama";
import { getIntentModelProvider, tryModelRoute } from "../src/intent/model-resolver";
import { canonicalModelJson } from "../src/intent/model-decoder";
import { warmFactoryPresets } from "../src/presets/factory-loader";
import { ENGINE_FILLED_FIELDS } from "../src/intent/model-schema";
import { datasetDoc } from "./intent-sft-doc.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENGINE_FILLED = new Set(ENGINE_FILLED_FIELDS);

/**
 * Strip the engine-filled contract fields from BOTH sides of the comparison.
 *
 * ENGINE_FILLED_FIELDS (src/intent/model-schema.ts) pins `detected`,
 * `matchedBy`, `sourceText` and `suggestions` as values the ENGINE computes
 * after routing — the architecture forbids them as model output, yet the SFT
 * corpus still teaches the model to emit them. Scoring them byte-exact
 * therefore measures a field the runtime overwrites anyway: a miss there is a
 * serialization artifact, not a behavioural defect.
 *
 * Stripping both sides keeps the comparison symmetric (same rule on truth and
 * on model) and scores only what the model is actually responsible for. The
 * `detected:["AI"]` degeneration seen in the v31/v32 evals is exactly this
 * case — `loudness` scored 0/6 on a field that is a pure function of
 * `targetDb` (src/intent/loudness.ts).
 */
function stripEngineFilled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEngineFilled);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (ENGINE_FILLED.has(key)) continue;
    out[key] = stripEngineFilled(val);
  }
  return out;
}

function trueLang(instruction: string): string {
  return /[äôúľščťžýáíé]/i.test(instruction.normalize("NFD")) ? "sk" : "en";
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const limit = Number(arg("limit") ?? 60);
const dumpFails = process.argv.includes("--dump-fails");
const fails: Array<{ instruction: string; trueKind: string; gotKind: string; reason: string; detail: string }> = [];
const requestedModel = arg("model");
if (requestedModel) setOllamaIntentModel(requestedModel);
setOllamaIntentModeOverride("on");

let model = await ensureOllamaIntentProvider();
for (let retry = 0; retry < 3 && !model; retry += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  model = await ensureOllamaIntentProvider();
}
if (!model) {
  console.error("ollama not reachable — is the server running and the model pulled?");
  process.exit(1);
}
console.log(`evaluating: ${getIntentModelProvider()?.id} (config default: ${ollamaIntentModel()})`);
console.log(`rows: ${limit} from val.jsonl\n`);

// The eval doc MUST be the corpus's own dataset doc: arrange/clips val rows
// name the dataset's role scenes and clips (Intro/Drop, clip-test-*) —
// against any other doc they are unanswerable by construction.
const doc = datasetDoc();
// The preset bank is a lazily-imported module: routeIntentText →
// parsePresetIntent → resolvePresetByName → factoryPresets() throws
// "factory preset bank not warmed" on the FIRST preset val row without this.
// Measured 2026-10-09: the full-val run died at row 1 of 298 until it was
// awaited here. A 60-row sample that happens to miss presets hides this.
await warmFactoryPresets();
const rows = readFileSync(path.join(ROOT, "scripts", "data", "intent-sft", "val.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as { instruction: string; response: { kind?: string } })
  .slice(0, limit);

const perKind = new Map<
  string,
  { rows: number; attempted: number; exact: number; wrongKind: number; abstain: number }
>();
let attempted = 0;
let exact = 0;
let wrongKind = 0;
let abstain = 0;
let schemaInvalid = 0;

for (const row of rows) {
  const truth = row.response;
  const trueKind = String(truth?.kind ?? "unknown");
  const bucket = perKind.get(trueKind) ?? { rows: 0, attempted: 0, exact: 0, wrongKind: 0, abstain: 0 };
  perKind.set(trueKind, bucket);
  bucket.rows += 1;

  const provider = getIntentModelProvider();
  let raw: string;
  try {
    raw = await provider!.generate(row.instruction, doc);
  } catch {
    abstain += 1;
    bucket.abstain += 1;
    continue;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    schemaInvalid += 1;
    abstain += 1;
    bucket.abstain += 1;
    continue;
  }
  const route = await tryModelRoute(row.instruction, doc);
  if (route === null) {
    abstain += 1;
    bucket.abstain += 1;
    continue;
  }
  attempted += 1;
  bucket.attempted += 1;
  if (route.kind !== trueKind) {
    wrongKind += 1;
    bucket.wrongKind += 1;
    fails.push({
      instruction: row.instruction,
      trueKind,
      gotKind: route.kind,
      reason: "wrongKind",
      detail: JSON.stringify(route).slice(0, 220),
    });
    continue;
  }
  // The resolver wraps "exact" actions into a plan ({kind, plan:{label, ops}})
  // — the engine-generated label is not model output, so the comparison
  // flattens to the ops the teacher carries.
  let comparable: unknown =
    route.kind === "exact" && route.plan && Array.isArray((route.plan as { ops?: unknown }).ops)
      ? { kind: route.kind, ops: (route.plan as { ops: unknown[] }).ops }
      : route;
  // Clips convention alignment (the ONNX decoder's documented contract):
  // the LLM grammar speaks 1-indexed human bars and may carry the ref/atBar
  // slots the schema allows, while the corpus truth is the engine form
  // (0-indexed toBar, no ref/atBar — clipId is engine-stripped by the
  // canonical comparison). Normalize the MODEL side onto the truth form so
  // the off-by-one is a convention, never a miss.
  if (route.kind === "clips" && Array.isArray((route as { ops?: unknown }).ops)) {
    comparable = {
      kind: "clips",
      ops: (route as { ops: Array<Record<string, unknown>> }).ops.map((op) => {
        const { ref, atBar, ...rest } = op;
        void ref;
        void atBar;
        return typeof rest.toBar === "number" ? { ...rest, toBar: rest.toBar - 1 } : rest;
      }),
    };
  }
  if (canonicalModelJson(stripEngineFilled(comparable)) === canonicalModelJson(stripEngineFilled(truth))) {
    exact += 1;
    bucket.exact += 1;
  } else {
    const want = JSON.stringify(truth).slice(0, 220);
    const got = JSON.stringify(comparable).slice(0, 220);
    fails.push({
      instruction: row.instruction,
      trueKind,
      gotKind: route.kind,
      reason: "wrongSlots",
      detail: `want=${want} got=${got}`,
    });
  }
}

console.log(
  `attempted-exact: ${exact}/${attempted} (${((exact / Math.max(1, attempted)) * 100).toFixed(1)}%)  ` +
    `wrongKind: ${wrongKind}  abstain: ${abstain}/${rows.length} (${((abstain / rows.length) * 100).toFixed(1)}%)  ` +
    `schema-invalid: ${schemaInvalid}`,
);
if (dumpFails) {
  for (const fail of fails) {
    console.log(`FAIL [${fail.reason}] (${trueLang(fail.instruction)}) ${JSON.stringify(fail.instruction)} ${fail.trueKind} → ${fail.gotKind}
   ${fail.detail}`);
  }
}
for (const [kind, bucket] of [...perKind.entries()].sort()) {
  console.log(
    `  ${kind.padEnd(14)} rows=${bucket.rows} exact=${bucket.exact}/${bucket.attempted} wrongKind=${bucket.wrongKind} abstain=${bucket.abstain}`,
  );
}

// ---------------------------------------------------------------------------
// Pinned report. Until 2026-10-09 this script only console.logged, so every
// LFM2.5 number in the docs was hand-transcribed from stdout into markdown —
// which is exactly how the corpus drifted out from under three different
// "pinned" scorecards. A number that only lives in a terminal is not evidence.
const OLLAMA_BASE = "http://127.0.0.1:11434";

function sha256File(rel: string): string {
  return createHash("sha256")
    .update(readFileSync(path.join(ROOT, rel)))
    .digest("hex");
}

async function ollamaProvenance(tag: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { requestedTag: tag, configuredDefault: ollamaIntentModel() };
  try {
    const version = (await (await fetch(`${OLLAMA_BASE}/api/version`)).json()) as { version?: string };
    out.ollamaVersion = version.version ?? null;
  } catch {
    out.ollamaVersion = null;
  }
  try {
    const tags = (await (await fetch(`${OLLAMA_BASE}/api/tags`)).json()) as {
      models?: Array<Record<string, unknown>>;
    };
    const all = tags.models ?? [];
    const hit = all.find((m) => m.name === tag) ?? all.find((m) => String(m.name).startsWith(tag.split(":")[0]));
    if (!hit) {
      out.registeredInOllama = false;
      return out;
    }
    out.registeredInOllama = true;
    out.ollamaModelName = hit.name ?? null;
    out.ollamaDigest = hit.digest ?? null;
    out.sizeBytes = hit.size ?? null;
    out.details = hit.details ?? null;
  } catch {
    out.registeredInOllama = null;
  }
  return out;
}

const reportPath =
  arg("report") ??
  path.join(
    ROOT,
    "scripts",
    "data",
    "intent-sft",
    `lfm-runtime-evaluation-${new Date().toISOString().slice(0, 10)}.json`,
  );

if (!process.argv.includes("--no-report")) {
  let manifest: { datasetVersion?: number; total?: number; train?: number; val?: number; golden?: number } = {};
  try {
    manifest = JSON.parse(readFileSync(path.join(ROOT, "scripts/data/intent-sft/manifest.json"), "utf8"));
  } catch {
    manifest = {};
  }
  const report = {
    reportVersion: 2,
    createdAt: new Date().toISOString().slice(0, 10),
    // Not a release qualification: labeled action routing on the val split,
    // nothing about musical quality, generalization or human usefulness.
    status: "measured-action-routing-validation-not-release-qualification",
    scope: {
      task: "intent action/slot routing against the labeled validation corpus",
      protocol: `scripts/eval-ollama-intent.mts --limit ${limit}`,
      comparison:
        "canonicalModelJson(stripEngineFilled(route)) vs the labeled response; clips bar indexing normalized on the model side",
      notEvaluated: [
        "musical or beat quality",
        "creative brief interpretation beyond the labeled action schema",
        "candidate-family-disjoint generalization",
        "human preference or usability",
      ],
    },
    model: await ollamaProvenance(requestedModel ?? model ?? "unknown"),
    dataset: {
      version: manifest.datasetVersion ?? null,
      split: "val",
      rows: rows.length,
      limitRequested: limit,
      counts: { train: manifest.train ?? null, val: manifest.val ?? null, golden: manifest.golden ?? null },
      // train.jsonl was MISSING from every earlier report, so a training run
      // could not be tied back to the exact rows it learned from.
      sha256: {
        trainJsonl: sha256File("scripts/data/intent-sft/train.jsonl"),
        valJsonl: sha256File("scripts/data/intent-sft/val.jsonl"),
        goldenJsonl: sha256File("scripts/data/intent-sft/golden.jsonl"),
        promptTxt: sha256File("scripts/data/intent-sft/prompt.txt"),
        manifestJson: sha256File("scripts/data/intent-sft/manifest.json"),
      },
    },
    runtime: { node: process.version },
    metrics: {
      rows: rows.length,
      attempted,
      exact,
      attemptedExactRate: Number((exact / Math.max(1, attempted)).toFixed(10)),
      wrongKind,
      abstain,
      abstainRate: Number((abstain / Math.max(1, rows.length)).toFixed(10)),
      schemaInvalid,
    },
    perKind: Object.fromEntries([...perKind.entries()].sort()),
    fails,
    sourceHashes: {
      "scripts/eval-ollama-intent.mts": sha256File("scripts/eval-ollama-intent.mts"),
      "src/intent/model-ollama.ts": sha256File("src/intent/model-ollama.ts"),
      "src/intent/model-resolver.ts": sha256File("src/intent/model-resolver.ts"),
      "src/intent/model-decoder.ts": sha256File("src/intent/model-decoder.ts"),
      "src/intent/model-schema.ts": sha256File("src/intent/model-schema.ts"),
    },
    limitations: [
      "The validation split measures labeled action routing only; exact-match does not establish musical usefulness.",
      "warm and cold Ollama runs are NOT comparable: the first generate pays the VRAM model load and can abort inside the 45 s timeout.",
      "Full-val runs are required for a verdict — a --limit 60 sample both flatters the model and can miss the preset rows entirely.",
      "golden.jsonl overlaps train/val after NFKC+whitespace normalization, so it is a regression set, not an independent holdout.",
    ],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nreport: ${path.relative(ROOT, reportPath)}`);
}
