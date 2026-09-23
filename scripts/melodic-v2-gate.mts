/**
 * MELODIC V2 SEMANTIC GATE — the melodic mirror of v3-hybrid-gate.
 *
 * The melodic-v2 prior was trained on genre-averaged style CENTROIDS from an
 * earlier embedding vintage, without label smoothing. A softmax head doesn't
 * saturate into walls the way a sigmoid grid does — it fails differently:
 * the semantic channel dies and OPPOSITE-MOOD prompts return (nearly)
 * IDENTICAL degree distributions.
 *
 * Gate: same structural context (role/step/history), two opposite-mood
 * texts via the REAL runtime conditioning (MiniLM embed → current PCA).
 * The degree distributions must differ measurably. Also functional checks:
 * distributions sum to ~1, finite.
 *
 * Run: npx vite-node scripts/melodic-v2-gate.mts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildMelodicV2FeatureRow, MELV2_FEATURE_COUNT } from "../src/ai/symbolic/melodic-features-v2";

const ROOT = process.cwd();
const modelsDir = path.join(ROOT, "public", "models");

const ort = await import("onnxruntime-web");
ort.env.wasm.wasmPaths =
  "file://" + path.join(ROOT, "node_modules", "onnxruntime-web", "dist").replace(/\\/g, "/") + "/";
ort.env.wasm.numThreads = 1;

const manifest = JSON.parse(readFileSync(path.join(modelsDir, "symbolic-melodic-v2.manifest.json"), "utf8"));
const modelBytes = readFileSync(path.join(modelsDir, path.basename(manifest.modelPath)));
const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});

// Real runtime conditioning: MiniLM embed → current PCA (identical to
// semanticConditioning in the app).
const pca = JSON.parse(readFileSync(path.join(ROOT, "scripts", "data", "pca-embedding-projection.json"), "utf8"));
function projectEmbeddingCurrent(vector: ArrayLike<number>): number[] {
  const centered = Array.from(vector, (v, d) => v - pca.mean[d]);
  return pca.components.map((comp: number[]) => comp.reduce((sum, c, d) => sum + c * centered[d], 0));
}
const { pipeline, env } = await import("@huggingface/transformers");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = path.join(ROOT, "public", "models", "semantic") + path.sep;
const extractor = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", { dtype: "q8" });
async function embedText(text: string): Promise<number[]> {
  const output = (await extractor([text], { pooling: "mean", normalize: true })) as { data: Float32Array };
  const projected = projectEmbeddingCurrent(Array.from(output.data));
  if (projected.length !== 16 || projected.some((x) => !Number.isFinite(x))) {
    throw new Error("conditioning projection failed");
  }
  return projected;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((s, x) => s + x, 0);
  return exps.map((x) => x / sum);
}

async function degreeDistribution(semantic: number[]): Promise<number[]> {
  const row = buildMelodicV2FeatureRow({
    semantic,
    role: "lead",
    startStep: 0,
    prevDegree: -1,
    prevDuration: 2,
    prevPrevDegree: -1,
  });
  if (row.length !== MELV2_FEATURE_COUNT) throw new Error(`feature width ${row.length} ≠ ${MELV2_FEATURE_COUNT}`);
  const batch = new Float32Array(MELV2_FEATURE_COUNT);
  batch.set(row, 0);
  const input = new ort.Tensor("float32", batch, [1, MELV2_FEATURE_COUNT]);
  const outputs = await session.run({ [manifest.inputName]: input });
  const logits = Array.from(outputs[manifest.degreeOutputName].data as Float32Array);
  return softmax(logits);
}

const darkDist = await degreeDistribution(await embedText("dark aggressive beat in the style of travis scott"));
const brightDist = await degreeDistribution(await embedText("smooth happy uplifting beat in the style of amapiano"));

const rms = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) * (x - b[i]), 0)) / Math.sqrt(a.length);
const distance = rms(darkDist, brightDist);
const sumsOk = [darkDist, brightDist].every((d) => Math.abs(d.reduce((s, x) => s + x, 0) - 1) < 0.01);
const argmaxDark = darkDist.indexOf(Math.max(...darkDist));
const argmaxBright = brightDist.indexOf(Math.max(...brightDist));

console.log("══════════════════════════════════════════════");
console.log("  MELODIC V2 SEMANTIC GATE");
console.log("══════════════════════════════════════════════");
console.log(`  dark degree dist:  [${darkDist.map((x) => x.toFixed(3)).join(", ")}]`);
console.log(`  bright degree dist: [${brightDist.map((x) => x.toFixed(3)).join(", ")}]`);
console.log(`  distribution RMS distance: ${distance.toFixed(4)}`);
console.log(`  sums ok: ${sumsOk} · argmax dark=${argmaxDark} bright=${argmaxBright}`);

const semanticAlive = distance > 0.01;
const functional = sumsOk;
console.log(`  SEMANTIC ALIVE ${semanticAlive ? "PASS" : "FAIL"} · FUNCTIONAL ${functional ? "PASS" : "FAIL"}`);
if (!(semanticAlive && functional)) process.exit(1);
console.log("\n[melodic-gate] semantic channel responds to mood ✔");
