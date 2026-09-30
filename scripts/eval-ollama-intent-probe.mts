/**
 * FAILURE PROBE — same yardstick as eval-ollama-intent.mts but logs every
 * non-exact row with instruction / truth / model output so corpus expansion
 * can target the exact confusion. Read-only: does not touch manifests.
 *
 *   npx vite-node scripts/eval-ollama-intent-probe.mts --model kyx-intent-v25-exp
 */
import { readFileSync } from "node:fs";
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
import { datasetDoc } from "./intent-sft-doc.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const limit = Number(arg("limit") ?? 254);
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
console.log(`PROBE evaluating: ${getIntentModelProvider()?.id} (config default: ${ollamaIntentModel()})`);
console.log(`rows: ${limit} from val.jsonl\n`);

// same doc as the corpus — see intent-sft-doc.mts for why this is mandatory
const doc = datasetDoc();
const rows = readFileSync(path.join(ROOT, "scripts", "data", "intent-sft", "val.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as { instruction: string; response: { kind?: string } })
  .slice(0, limit);

let attempted = 0;
let exact = 0;
let wrongKind = 0;
let abstain = 0;
let schemaInvalid = 0;
const failures: string[] = [];

for (let i = 0; i < rows.length; i += 1) {
  const row = rows[i];
  const truth = row.response;
  const trueKind = String(truth?.kind ?? "unknown");

  const provider = getIntentModelProvider();
  let raw: string;
  try {
    raw = await provider!.generate(row.instruction, doc);
  } catch (err) {
    abstain += 1;
    failures.push(`#${i} ABSTAIN-THROW kind=${trueKind}\n  q: ${row.instruction}\n  err: ${String(err).slice(0, 200)}`);
    continue;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    schemaInvalid += 1;
    abstain += 1;
    failures.push(`#${i} ABSTAIN-SCHEMA kind=${trueKind}\n  q: ${row.instruction}\n  raw: ${raw.slice(0, 300)}`);
    continue;
  }
  const route = await tryModelRoute(row.instruction, doc);
  if (route === null) {
    abstain += 1;
    failures.push(`#${i} ABSTAIN-ROUTE kind=${trueKind}\n  q: ${row.instruction}\n  raw: ${raw.slice(0, 300)}`);
    continue;
  }
  attempted += 1;
  if (route.kind !== trueKind) {
    wrongKind += 1;
    failures.push(
      `#${i} WRONG-KIND model=${route.kind} truth=${trueKind}\n  q: ${row.instruction}\n  model: ${raw.slice(0, 300)}\n  truth: ${JSON.stringify(truth).slice(0, 300)}`,
    );
    continue;
  }
  const comparable =
    route.kind === "exact" && route.plan && Array.isArray((route.plan as { ops?: unknown }).ops)
      ? { kind: route.kind, ops: (route.plan as { ops: unknown[] }).ops }
      : route;
  if (canonicalModelJson(comparable) !== canonicalModelJson(truth)) {
    failures.push(
      `#${i} KIND-OK-NOT-EXACT kind=${trueKind}\n  q: ${row.instruction}\n  model: ${JSON.stringify(comparable).slice(0, 400)}\n  truth: ${JSON.stringify(truth).slice(0, 400)}`,
    );
  } else {
    exact += 1;
  }
}

const pct = ((exact / Math.max(1, attempted)) * 100).toFixed(1);
console.log(
  `attempted-exact: ${exact}/${attempted} (${pct}%)  wrongKind: ${wrongKind}  abstain: ${abstain}/${rows.length}  schema-invalid: ${schemaInvalid}`,
);
console.log(`\n===== ${failures.length} FAILURES =====`);
for (const f of failures) console.log(f + "\n");
