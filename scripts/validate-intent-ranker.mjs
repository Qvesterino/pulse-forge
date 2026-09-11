/**
 * Validates the trained ONNX artifact with ONNX Runtime (goal doc Fáze 2/5):
 * loads public/models/intent-ranker-v1.onnx, checks input/output metadata
 * against the manifest, runs a deterministic probe batch and verifies the
 * output shape + finiteness + artifact size/hash contract.
 *
 * Run: node scripts/validate-intent-ranker.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = path.join(ROOT, "public", "models");
const manifest = JSON.parse(readFileSync(path.join(modelsDir, "intent-ranker-v1.manifest.json"), "utf8"));
const modelPath = path.join(modelsDir, path.basename(manifest.modelPath));
const modelBytes = readFileSync(modelPath);
const actualHash = createHash("sha256").update(modelBytes).digest("hex");
if (actualHash !== String(manifest.modelHash ?? "").toLowerCase()) throw new Error("model hash mismatch");

// Serve the repo so the browser-compatible runtime has a same-origin context;
// its WASM binary remains a local node_modules asset for this dev-only gate.
const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: 5237, host: "127.0.0.1", strictPort: true },
});
await server.listen();

try {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  if (session.inputNames[0] !== manifest.inputName) throw new Error(`input name mismatch: ${session.inputNames[0]}`);
  if (session.outputNames[0] !== manifest.outputName) throw new Error(`output name mismatch: ${session.outputNames[0]}`);

  const featureCount = manifest.featureCount;
  const probe = new ort.Tensor("float32", new Float32Array(featureCount * 3).fill(0.4), [3, featureCount]);
  const results = await session.run({ [manifest.inputName]: probe });
  const scores = results[manifest.outputName].data;
  if (scores.length !== 3) throw new Error(`output length ${scores.length} != 3`);
  for (const score of scores) if (!Number.isFinite(score)) throw new Error("non-finite score");
  const resultsAgain = await session.run({ [manifest.inputName]: probe });
  for (let index = 0; index < scores.length; index++) {
    if (resultsAgain[manifest.outputName].data[index] !== scores[index]) throw new Error("non-deterministic inference");
  }
  if (modelBytes.length > 1024 * 1024) throw new Error(`model artifact too large: ${(modelBytes.length / 1024).toFixed(1)} kB`);
  console.log(
    `[validate] OK — candidates=3 outputs=[${[...scores].map((score) => Number(score).toFixed(4))}] ` +
      `size=${(modelBytes.length / 1024).toFixed(1)} kB sha256=${actualHash.slice(0, 16)}…`,
  );
} finally {
  await server.close();
}
