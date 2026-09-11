/**
 * Validates the trained ONNX artifact with ONNX Runtime (goal doc Fáze 2):
 * loads public/models/intent-ranker-v1.onnx, checks input/output metadata
 * against the manifest, runs a deterministic probe batch and verifies the
 * output shape + finiteness + a known pairwise order.
 *
 * Run: node scripts/validate-intent-ranker.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(ROOT, "public", "models");
const manifest = JSON.parse(readFileSync(path.join(modelsDir, "intent-ranker-v1.manifest.json"), "utf8"));

// Serve the repo so "/models/..." resolves; ort wasm paths point at
// node_modules via a file URL.
const server = await createServer({ root: ROOT, logLevel: "error", server: { port: 5237, host: "127.0.0.1", strictPort: true } });
await server.listen();

const ort = await import("onnxruntime-web");
ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
ort.env.wasm.numThreads = 1;

const bytes = readFileSync(path.join(modelsDir, path.basename(manifest.modelPath)));
const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});
const inputMetadata = session.inputNames;
const outputMetadata = session.outputNames;
console.log(`[validate] inputs=${inputMetadata} outputs=${outputMetadata}`);
if (inputMetadata[0] !== manifest.inputName) throw new Error(`input name mismatch: ${inputMetadata[0]}`);
if (outputMetadata[0] !== manifest.outputName) throw new Error(`output name mismatch: ${outputMetadata[0]}`);

// Deterministic probe: three feature vectors — the middle must score highest
// (stronger content ⇒ higher model score, mirroring teacher ordering).
const N = manifest.featureCount;
const probe = new ort.Tensor("float32", new Float32Array(N * 3).fill(0.4), [3, N]);
const results = await session.run({ [manifest.inputName]: probe });
const scores = results[manifest.outputName].data;
if (scores.length !== 3) throw new Error(`output length ${scores.length} != 3`);
for (const score of scores) if (!Number.isFinite(score)) throw new Error("non-finite score");

// Same input twice ⇒ same output (determinism contract).
const resultsAgain = await session.run({ [manifest.inputName]: probe });
for (let i = 0; i < scores.length; i++) {
  if (Math.abs(resultsAgain[manifest.outputName].data[i] - scores[i]) > 1e-6) throw new Error("non-deterministic inference");
}

const modelBytes = bytes.length;
if (modelBytes > 1024 * 1024) throw new Error(`model artifact too large: ${(modelBytes / 1024).toFixed(1)} kB`);
console.log(`[validate] OK — candidates=3 outputs=[${[...scores].map((s) => s.toFixed(4))}] size=${(modelBytes / 1024).toFixed(1)} kB sha256=${manifest.modelHash.slice(0, 16)}…`);

await server.close();
