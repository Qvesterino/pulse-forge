/**
 * EMBEDDING-CONDITIONED PRIOR TRAINING PIPELINE (INTENT_ENGINE.md Fáze B-E).
 *
 * 1. Generates text descriptions for every genre×style combination
 * 2. Embeds descriptions with MiniLM (the semantic layer's model)
 * 3. Computes PCA projection 384→16
 * 4. Builds augmented training dataset with PCA-projected embeddings
 *    replacing one-hot genre/style features
 * 5. Trains prior v2 models (35-dim input: 16 PCA + 19 structural)
 * 6. Validates and saves artifacts
 *
 * This is the most impactful ML upgrade — it moves the priors from
 * "learn 27 known styles" to "understand semantic meaning of any text."
 *
 * Prerequisites: npm run semantic:fetch (MiniLM model must be available)
 * Run: npx vite-node scripts/train-embedding-prior.mts
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "scripts", "data");
mkdirSync(OUT_DIR, { recursive: true });

// ── Phase A: text descriptions ─────────────────────────────────────────────
const { generateAllDescriptions } = await import("../src/intent/descriptions");
const { buildSemanticCorpus } = await import("../src/intent/semantic");

const GENRES = ["house", "techno", "trap", "ambient"] as const;
const descriptionSets = generateAllDescriptions(GENRES);

const allDescriptions: string[] = [];
for (const [, set] of descriptionSets) {
  allDescriptions.push(...set.descriptions);
}
// Also embed the semantic corpus texts for broader coverage
const semanticCorpus = buildSemanticCorpus();
const corpusTexts = semanticCorpus.map((e) => e.text);
allDescriptions.push(...corpusTexts);

console.log(`[embed-prior] ${allDescriptions.length} text descriptions generated`);

// ── Phase B: MiniLM embedding ──────────────────────────────────────────────
const { pipeline, env } = await import("@huggingface/transformers");
env.allowLocalModels = true;
env.allowRemoteModels = false;
const semanticDir = path.join(ROOT, "public", "models", "semantic");
env.localModelPath = semanticDir + path.sep;

console.log("[embed-prior] loading MiniLM …");
const extractor = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", { dtype: "q8" });

async function embed(texts: string[]): Promise<Float32Array[]> {
  const output = (await extractor(texts, { pooling: "mean", normalize: true })) as {
    data: Float32Array;
    dims: number[];
  };
  const [rows, dim] = output.dims;
  const vectors: Float32Array[] = [];
  for (let row = 0; row < rows; row++) {
    vectors.push(output.data.slice(row * dim, (row + 1) * dim));
  }
  return vectors;
}

// Embed in batches of 64
const embeddings: Float32Array[] = [];
const BATCH = 64;
for (let start = 0; start < allDescriptions.length; start += BATCH) {
  const batch = allDescriptions.slice(start, start + BATCH);
  const vectors = await embed(batch);
  embeddings.push(...vectors);
  if ((start / BATCH) % 10 === 0) {
    console.log(`[embed-prior] embedded ${Math.min(start + BATCH, allDescriptions.length)}/${allDescriptions.length}`);
  }
}
console.log(`[embed-prior] embedded ${embeddings.length} descriptions (${embeddings[0]?.length ?? 0} dims)`);

// ── Phase C: PCA projection 384→16 ────────────────────────────────────────
function pca(data: Float32Array[], nComponents: number) {
  const n = data.length;
  const dim = data[0].length;
  // Mean
  const mean = new Float64Array(dim);
  for (const vec of data) for (let d = 0; d < dim; d++) mean[d] += vec[d] / n;
  // Center
  const centered = data.map((vec) => Float64Array.from(vec, (v, d) => v - mean[d]));
  // Covariance matrix (dim × dim) — greedy top-k via power iteration
  // For 384 dims this is 147k entries — manageable
  const components: Float64Array[] = [];
  const cov = new Float64Array(dim * dim);
  for (const vec of centered) {
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        cov[i * dim + j] += vec[i] * vec[j] / n;
      }
    }
  }
  // Power iteration with deflation for top-k eigenvectors
  const eigenvalues: number[] = [];
  const eigenvectors: Float64Array[] = [];
  const deflated = Float64Array.from(cov);
  for (let k = 0; k < nComponents; k++) {
    let v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) v[d] = Math.sin(d * 12.9898 + k * 78.233) * 43758.5453 % 1;
    let eigenvalue = 0;
    for (let iter = 0; iter < 200; iter++) {
      const next = new Float64Array(dim);
      for (let i = 0; i < dim; i++) {
        for (let j = 0; j < dim; j++) next[i] += deflated[i * dim + j] * v[j];
      }
      const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0));
      if (norm < 1e-12) break;
      for (let d = 0; d < dim; d++) next[d] /= norm;
      const newEigen = next.reduce((s, x, i) => s + x * next[i], 0);
      if (Math.abs(newEigen - eigenvalue) < 1e-10) { eigenvalue = newEigen; v = next; break; }
      eigenvalue = newEigen;
      v = next;
    }
    eigenvalues.push(eigenvalue);
    eigenvectors.push(Float64Array.from(v));
    // Deflate: subtract the component from the covariance matrix
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        deflated[i * dim + j] -= eigenvalue * v[i] * v[j];
      }
    }
  }
  return { mean: Array.from(mean), components: eigenvectors.map(v => Array.from(v)), eigenvalues };
}

console.log("[embed-prior] computing PCA 384→16 …");
const pcaResult = pca(embeddings, 16);
const projected = embeddings.map((vec) => {
  const centered = vec.map((v, d) => v - pcaResult.mean[d]);
  return pcaResult.components.map((comp) =>
    comp.reduce((sum, c, d) => sum + c * centered[d], 0)
  );
});
console.log(`[embed-prior] PCA done: ${pcaResult.eigenvalues.slice(0, 4).map(v => v.toFixed(3)).join(", ")} …`);

// Save PCA model
writeFileSync(
  path.join(OUT_DIR, "pca-embedding-projection.json"),
  JSON.stringify({
    version: "pca-embedding-v1",
    inputDims: 384,
    outputDims: 16,
    mean: pcaResult.mean,
    components: pcaResult.components,
    eigenvalues: pcaResult.eigenvalues,
  })
);
console.log("[embed-prior] PCA projection saved");

// ── Save enriched dataset for the trainers ────────────────────────────────
// The trainers read the SAME format as before but now each sample has an
// additional `embedding` field (the PCA-projected vector).

writeFileSync(
  path.join(OUT_DIR, "embedding-descriptions.json"),
  JSON.stringify({
    version: "embedding-descriptions-v1",
    modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    pcaVersion: "pca-embedding-v1",
    descriptions: allDescriptions.map((text, i) => ({
      text,
      embedding: Array.from(projected[i]),
    })),
  })
);
console.log(`[embed-prior] embedding descriptions saved → ${path.join(OUT_DIR, "embedding-descriptions.json")}`);
console.log("[embed-prior] Phase A-C done. Now run:");
console.log("  python scripts/train-symbolic-prior.py --embedding scripts/data/embedding-descriptions.json");
console.log("  python scripts/train-symbolic-melodic.py --embedding scripts/data/embedding-descriptions.json");
