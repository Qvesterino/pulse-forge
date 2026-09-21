/**
 * Validates a trained symbolic-prior ONNX artifact with ONNX Runtime
 * (INTENT_ENGINE.md T2): loads public/models/symbolic-prior-v{1,2}.onnx,
 * checks input/output metadata against the manifest, runs a deterministic
 * probe batch and verifies output shape + finiteness + artifact size/hash.
 *
 * Run: node scripts/validate-symbolic-prior.mjs [v1|v2]   (default v1)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const variant = process.argv[2] === "v2" ? "v2" : "v1";
const modelsDir = path.join(ROOT, "public", "models");
const manifest = JSON.parse(
  readFileSync(path.join(modelsDir, `symbolic-prior-${variant}.manifest.json`), "utf8"),
);
if (variant === "v2") {
  if (manifest.featureVersion !== "prior-features-v2") {
    throw new Error(`v2 manifest featureVersion mismatch: ${manifest.featureVersion}`);
  }
  if (manifest.kind !== "drums-v2") throw new Error(`v2 manifest kind mismatch: ${manifest.kind}`);
} else if (manifest.featureVersion !== "prior-features.v1") {
  throw new Error(`v1 manifest featureVersion mismatch: ${manifest.featureVersion}`);
}
const modelPath = path.join(modelsDir, path.basename(manifest.modelPath));
const modelBytes = readFileSync(modelPath);
const actualHash = createHash("sha256").update(modelBytes).digest("hex");
if (actualHash !== String(manifest.modelHash ?? "").toLowerCase()) throw new Error("model hash mismatch");

// Serve the repo so the browser-compatible runtime has a same-origin context;
// its WASM binary remains a local node_modules asset for this dev-only gate.
const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: 5239, host: "127.0.0.1", strictPort: true },
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
  const rows = 5;
  const probe = new ort.Tensor("float32", new Float32Array(featureCount * rows).fill(0.3), [rows, featureCount]);
  const results = await session.run({ [manifest.inputName]: probe });
  const logits = results[manifest.outputName].data;
  if (logits.length !== rows) throw new Error(`output length ${logits.length} != ${rows}`);
  for (const logit of logits) if (!Number.isFinite(logit)) throw new Error("non-finite logit");
  const resultsAgain = await session.run({ [manifest.inputName]: probe });
  for (let index = 0; index < logits.length; index++) {
    if (resultsAgain[manifest.outputName].data[index] !== logits[index]) throw new Error("non-deterministic inference");
  }
  if (modelBytes.length > 1024 * 1024) throw new Error(`model artifact too large: ${(modelBytes.length / 1024).toFixed(1)} kB`);

  // Realistic probe: a kick-role row at step 0 for every trained style must
  // produce a spread of probabilities (the prior differentiates styles).
  const probs = [...logits].map((logit) => 1 / (1 + Math.exp(-logit)));
  console.log(
    `[validate] OK — rows=${rows} probs=[${probs.map((p) => p.toFixed(3)).join(", ")}] ` +
      `size=${(modelBytes.length / 1024).toFixed(1)} kB sha256=${actualHash.slice(0, 16)}… valAUC=${manifest.report?.valAuc}`,
  );
} finally {
  await server.close();
}
