/**
 * INTENT MODEL EVAL — scores a fine-tuned model's predictions against the
 * deterministic teacher (the intent layer itself).
 *
 * Input: a JSONL file of { instruction, response } rows where `response` is
 * the MODEL's emitted action JSON (same schema as compactIntentResponse).
 * Scoring:
 *   exact   — byte-equal JSON against the teacher's route (the ideal)
 *   kindOK  — right action kind, params differ (partial credit, honest)
 *   miss    — wrong kind or unparsable JSON (the model hallucinated an op)
 * Reported per kind and overall, so fine-tune regressions localize.
 *
 * Run: npx vite-node scripts/eval-intent-model.mts path/to/predictions.jsonl
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { useDeterministicIds, resetDeterministicIds } from "../src/shared/ids";
import { addArrangementClip, createScene, setSceneRole } from "../src/commands/commands";
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import type { ProjectDocument } from "../src/project-model/types";

const predictionsPath = process.argv[2];
if (!predictionsPath) {
  console.error("usage: vite-node scripts/eval-intent-model.mts <predictions.jsonl>");
  process.exit(1);
}

function datasetDoc(): ProjectDocument {
  useDeterministicIds();
  resetDeterministicIds();
  let doc = createProjectFromTemplate("house");
  doc = { ...doc, arrangement: { ...doc.arrangement, clips: [] }, markers: [] };
  doc = createScene(doc, "Intro").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
  doc = createScene(doc, "Drop").execute(doc);
  doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
  doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
  return doc;
}

interface Row {
  instruction: string;
  response: unknown;
}

const doc = datasetDoc();
const rows: Row[] = readFileSync(path.resolve(predictionsPath), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Row);

const perKind = new Map<string, { exact: number; kindOK: number; miss: number }>();
let exact = 0;
let kindOK = 0;
let miss = 0;

for (const row of rows) {
  const truth = compactIntentResponse(routeIntentText(row.instruction, doc));
  const kind = String(truth.kind);
  const bucket = perKind.get(kind) ?? { exact: 0, kindOK: 0, miss: 0 };
  perKind.set(kind, bucket);
  let parsed: unknown;
  try {
    parsed = typeof row.response === "string" ? JSON.parse(row.response) : row.response;
  } catch {
    parsed = null;
  }
  if (parsed != null && JSON.stringify(parsed) === JSON.stringify(truth)) {
    exact++;
    bucket.exact++;
  } else if (parsed != null && typeof parsed === "object" && (parsed as { kind?: string }).kind === truth.kind) {
    kindOK++;
    bucket.kindOK++;
  } else {
    miss++;
    bucket.miss++;
  }
}

console.log(`rows: ${rows.length}`);
console.log(`exact: ${exact} (${Math.round((exact / rows.length) * 100)}%)`);
console.log(`kindOK: ${kindOK} (${Math.round((kindOK / rows.length) * 100)}%)`);
console.log(`miss: ${miss} (${Math.round((miss / rows.length) * 100)}%)`);
console.log("--- per kind ---");
for (const [kind, bucket] of [...perKind.entries()].sort()) {
  console.log(`${kind.padEnd(14)} exact=${bucket.exact} kindOK=${bucket.kindOK} miss=${bucket.miss}`);
}
