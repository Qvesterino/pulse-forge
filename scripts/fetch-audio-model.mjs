/**
 * Downloads the audio classification model (INTENT_ENGINE.md T4) into
 * public/models/audio/ in the HF layout transformers.js expects, so the app
 * serves it from its own origin (offline-first after the one-time fetch;
 * never committed to git).
 *
 * Default: Xenova/ast-finetuned-audioset-10-10-0.4593 q8 (AudioSet 527
 * classes: drums, cymbals, 808/bass, sweeps… — the drum-maker palette).
 *
 * Run: npm run audio:fetch
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = "Xenova/ast-finetuned-audioset-10-10-0.4593";
const BASE = "https://huggingface.co/" + REPO + "/resolve/main/";
const OUT = path.join(process.cwd(), "public", "models", "audio");
const MODEL_DIR = path.join(OUT, ...REPO.split("/"));

const FILES = [
  { remote: "onnx/model_quantized.onnx", local: "onnx/model_quantized.onnx" },
  { remote: "preprocessor_config.json", local: "preprocessor_config.json" },
  { remote: "config.json", local: "config.json" },
];

mkdirSync(path.join(MODEL_DIR, "onnx"), { recursive: true });

const hashes = {};
for (const file of FILES) {
  console.log(`[audio:fetch] fetching ${file.remote} …`);
  const response = await fetch(BASE + file.remote);
  if (!response.ok) throw new Error(`${file.remote}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(path.join(MODEL_DIR, file.local), buffer);
  hashes[file.local] = createHash("sha256").update(buffer).digest("hex");
  console.log(`[audio:fetch]   done (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

const manifest = {
  audioVersion: "audio-tag.v1",
  modelId: REPO,
  dtype: "q8",
  files: hashes,
};
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[audio:fetch] OK → ${OUT} (model ${REPO}, q8)`);
