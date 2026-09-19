/**
 * Downloads the semantic embedding model (INTENT_ENGINE.md T1 krok 2) into
 * public/models/semantic/ using the HF-hosting convention transformers.js
 * expects, so the app can serve it from its own origin (offline-first after
 * the one-time fetch; never committed to git).
 *
 * Default: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (EN+SK, q8 ≈ 120 MB).
 * `--mini` fetches Xenova/all-MiniLM-L6-v2 q8 (~23 MB) — same pipeline,
 * English-only; used for quick end-to-end verification.
 *
 * Run: npm run semantic:fetch [-- --mini]
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const MINI = process.argv.includes("--mini");
const REPO = MINI ? "Xenova/all-MiniLM-L6-v2" : "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const BASE = "https://huggingface.co/" + REPO + "/resolve/main/";
const OUT = path.join(process.cwd(), "public", "models", "semantic");
// transformers.js resolves a model ID beneath env.localModelPath, so mirror
// the repository path instead of placing files directly in the model root.
const MODEL_DIR = path.join(OUT, ...REPO.split("/"));

const FILES = [
  { remote: "onnx/model_quantized.onnx", local: "onnx/model_quantized.onnx" },
  { remote: "tokenizer.json", local: "tokenizer.json" },
  { remote: "tokenizer_config.json", local: "tokenizer_config.json" },
  { remote: "config.json", local: "config.json" },
];

mkdirSync(path.join(MODEL_DIR, "onnx"), { recursive: true });

const hashes = {};
for (const file of FILES) {
  console.log(`[semantic:fetch] fetching ${file.remote} …`);
  const response = await fetch(BASE + file.remote);
  if (!response.ok) throw new Error(`${file.remote}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(path.join(MODEL_DIR, file.local), buffer);
  hashes[file.local] = createHash("sha256").update(buffer).digest("hex");
  console.log(`[semantic:fetch]   done (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

const manifest = {
  semanticVersion: "semantic-embed.v1",
  modelId: REPO,
  dtype: "q8",
  files: hashes,
};
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[semantic:fetch] OK → ${MODEL_DIR} (model ${REPO}, q8)`);
