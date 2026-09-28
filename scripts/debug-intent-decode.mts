import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIntentBow, decodeIntentHeads, canonicalModelJson, type IntentModelVocab } from "../src/intent/model-decoder";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ort = await import("onnxruntime-web");
ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
ort.env.wasm.numThreads = 1;
const manifest = JSON.parse(readFileSync(path.join(ROOT, "public/models/intent-model-v1.manifest.json"), "utf8"));
const modelBytes = readFileSync(path.join(ROOT, "public/models/intent-model-v1.onnx"));
const vocab = JSON.parse(readFileSync(path.join(ROOT, "public/models/intent-model-v1.vocab.json"), "utf8")) as IntentModelVocab;
const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ["wasm"] });

const rows = readFileSync(path.join(ROOT, "scripts/data/intent-sft/val.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const row of rows.slice(0, 8)) {
  const bow = buildIntentBow(row.instruction, vocab.tokens);
  const results = (await session.run({ features: new ort.Tensor("float32", bow, [1, bow.length]) })) as Record<string, { data: Float32Array }>;
  const outputs: Record<string, Float32Array> = {};
  for (const name of manifest.features.outputNames) outputs[name] = results[name].data;
  const decoded = decodeIntentHeads(outputs, vocab);
  const kindScores = Array.from(outputs["head_kind"]);
  const kindHead = vocab.heads.find((h) => h.name === "kind")!;
  const sorted = kindScores.map((s, i) => [kindHead.classes[i], s] as const).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log("IN :", row.instruction);
  console.log("TRUE:", canonicalModelJson(row.response));
  console.log("GOT :", decoded ? canonicalModelJson(decoded) : "null (abstain)");
  console.log("kind top3:", sorted.map(([c, s]) => `${c}:${s.toFixed(2)}`).join(" "));
  console.log("");
}
