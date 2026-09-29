/**
 * LIVE EVAL — runs VAL corpus rows through the Ollama intent provider and
 * scores assembled exact/kindOK against the teacher (same yardstick as
 * validate-intent-model.mts). The pre/post-SFT comparison instrument:
 *
 *   baseline:  npx vite-node scripts/eval-ollama-intent.mts
 *   SFT model: npx vite-node scripts/eval-ollama-intent.mts --model kyx-intent-sft
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
import { createProjectFromTemplate } from "../src/project-model/templates";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const limit = Number(arg("limit") ?? 60);
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

const doc = createProjectFromTemplate("house");
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
    continue;
  }
  // The resolver wraps "exact" actions into a plan ({kind, plan:{label, ops}})
  // — the engine-generated label is not model output, so the comparison
  // flattens to the ops the teacher carries.
  const comparable =
    route.kind === "exact" && route.plan && Array.isArray((route.plan as { ops?: unknown }).ops)
      ? { kind: route.kind, ops: (route.plan as { ops: unknown[] }).ops }
      : route;
  if (canonicalModelJson(comparable) === canonicalModelJson(truth)) {
    exact += 1;
    bucket.exact += 1;
  }
}

console.log(
  `attempted-exact: ${exact}/${attempted} (${((exact / Math.max(1, attempted)) * 100).toFixed(1)}%)  ` +
    `wrongKind: ${wrongKind}  abstain: ${abstain}/${rows.length} (${((abstain / rows.length) * 100).toFixed(1)}%)  ` +
    `schema-invalid: ${schemaInvalid}`,
);
for (const [kind, bucket] of [...perKind.entries()].sort()) {
  console.log(
    `  ${kind.padEnd(14)} rows=${bucket.rows} exact=${bucket.exact}/${bucket.attempted} wrongKind=${bucket.wrongKind} abstain=${bucket.abstain}`,
  );
}
