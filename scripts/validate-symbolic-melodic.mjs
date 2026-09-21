/**
 * Validates a trained symbolic-melodic ONNX artifact with ONNX Runtime
 * (INTENT_ENGINE.md T2 v2): loads public/models/symbolic-melodic-v{1,2}.onnx,
 * checks input/output metadata against the manifest, runs a deterministic
 * probe batch and verifies both head outputs + finiteness + hash contract.
 *
 * Run: node scripts/validate-symbolic-melodic.mjs [v1|v2]   (default v1)
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
  readFileSync(path.join(modelsDir, `symbolic-melodic-${variant}.manifest.json`), "utf8"),
);
if (variant === "v2") {
  if (manifest.featureVersion !== "melodic-features-v2") {
    throw new Error(`v2 manifest featureVersion mismatch: ${manifest.featureVersion}`);
  }
  if (manifest.kind !== "melodic-v2") throw new Error(`v2 manifest kind mismatch: ${manifest.kind}`);
} else if (manifest.featureVersion !== "melodic-features.v1") {
  throw new Error(`v1 manifest featureVersion mismatch: ${manifest.featureVersion}`);
}
const modelPath = path.join(modelsDir, path.basename(manifest.modelPath));
const modelBytes = readFileSync(modelPath);
const actualHash = createHash("sha256").update(modelBytes).digest("hex");
if (actualHash !== String(manifest.modelHash ?? "").toLowerCase()) throw new Error("model hash mismatch");

const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: 5241, host: "127.0.0.1", strictPort: true },
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
  for (const name of [manifest.degreeOutputName, manifest.durationOutputName]) {
    if (!session.outputNames.includes(name)) throw new Error(`missing output: ${name} (has ${session.outputNames.join(",")})`);
  }

  const featureCount = manifest.featureCount;
  const rows = 4;
  const probe = new ort.Tensor("float32", new Float32Array(featureCount * rows).fill(0.25), [rows, featureCount]);
  const results = await session.run({ [manifest.inputName]: probe });
  const degree = results[manifest.degreeOutputName].data;
  const duration = results[manifest.durationOutputName].data;
  if (degree.length !== rows * manifest.degreeClasses) throw new Error(`degree length ${degree.length}`);
  if (duration.length !== rows * manifest.durationClasses) throw new Error(`duration length ${duration.length}`);
  for (const value of [...degree, ...duration]) if (!Number.isFinite(value)) throw new Error("non-finite logit");
  const again = await session.run({ [manifest.inputName]: probe });
  for (let index = 0; index < degree.length; index++) {
    if (again[manifest.degreeOutputName].data[index] !== degree[index]) throw new Error("non-deterministic inference");
  }
  if (modelBytes.length > 1024 * 1024) throw new Error(`model artifact too large: ${(modelBytes.length / 1024).toFixed(1)} kB`);

  const softmaxAt = (data, row, size) => {
    const slice = [...data.slice(row * size, (row + 1) * size)];
    const max = Math.max(...slice);
    const exp = slice.map((v) => Math.exp(v - max));
    const sum = exp.reduce((s, v) => s + v, 0);
    return exp.map((v) => v / sum);
  };
  const degreeDist = softmaxAt(degree, 0, manifest.degreeClasses);
  const durationDist = softmaxAt(duration, 0, manifest.durationClasses);
  console.log(
    `[validate] OK — degree=[${degreeDist.map((p) => p.toFixed(3)).join(",")}] ` +
      `duration=[${durationDist.map((p) => p.toFixed(3)).join(",")}] ` +
      `size=${(modelBytes.length / 1024).toFixed(1)} kB sha256=${actualHash.slice(0, 16)}…`,
  );
} finally {
  await server.close();
}
