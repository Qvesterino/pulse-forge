/**
 * Generates style→semantic-vector lookup for embedding-conditioned priors.
 *
 * For each PRIOR_STYLE_VOCAB entry, generates descriptions, embeds them with
 * MiniLM, applies the PCA projection, and averages → one 16-dim vector per
 * style. Python trainers load this JSON to replace one-hot genre/style with
 * semantic conditioning.
 *
 * Run: npx vite-node scripts/generate-style-embeddings.mts
 */
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { PRIOR_STYLE_VOCAB } from "../src/ai/symbolic/prior-features";
import { generateDescriptions } from "../src/intent/descriptions";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "scripts", "data");
const PCA = JSON.parse(readFileSync(path.join(OUT_DIR, "pca-embedding-projection.json"), "utf8"));
const pcaMean = Float64Array.from(PCA.mean);
const pcaComponents = PCA.components;

// MiniLM pipeline for embedding
const { pipeline, env } = await import("@huggingface/transformers");
env.allowLocalModels = true;
env.allowRemoteModels = false;
const semanticDir = path.join(ROOT, "public", "models", "semantic");
env.localModelPath = semanticDir + path.sep;

console.log("[style-embed] loading MiniLM …");
const extractor = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", { dtype: "q8" });

async function embed(texts: string[]): Promise<Float32Array[]> {
  const output = (await extractor(texts, { pooling: "mean", normalize: true })) as {
    data: Float32Array;
    dims: number[];
  };
  const [rows, dim] = output.dims;
  const vectors: Float32Array[] = [];
  for (let row = 0; row < rows; row++) vectors.push(output.data.slice(row * dim, (row + 1) * dim));
  return vectors;
}

/** Project a 384-dim embedding through PCA to 16 dims. */
function project(embedding: Float32Array | number[]): number[] {
  const e = Float64Array.from(embedding);
  const centered = e.map((v, d) => v - pcaMean[d]);
  return pcaComponents.map((comp) => comp.reduce((sum, c, d) => sum + c * centered[d], 0));
}

// Generate descriptions per style and embed them
const styleEmbeddings: Record<string, number[]> = {};
const styleEmbeddingVariants: Record<string, number[][]> = {};
const genreFor: Record<string, string> = {};

for (const styleId of PRIOR_STYLE_VOCAB) {
  const genre = styleId.split(".")[0] as "house" | "techno" | "trap" | "ambient";
  const styleKey = styleId.split(".")[1] ?? styleId;
  genreFor[styleId] = genre;

  const descriptions = generateDescriptions(genre, styleKey, null, null, 20);
  if (descriptions.length === 0) {
    console.warn(`[style-embed] no descriptions for ${styleId}`);
    continue;
  }

  const vectors = await embed(descriptions);
  // Average the embeddings
  const avg = new Float64Array(vectors[0].length);
  for (const vec of vectors) for (let d = 0; d < vec.length; d++) avg[d] += vec[d] / vectors.length;

  // Project EVERY description through PCA — the centroid alone taught the
  // prior one semantic point per style, and free-text prompts (farther from
  // the centroid) then saturated its logits (v3 gate finding). All variants
  // go into training; the centroid stays as the runtime-facing average.
  const projectedVariants = vectors.map((vec) => project(vec));
  const projected = project(avg);
  styleEmbeddings[styleId] = projected;
  styleEmbeddingVariants[styleId] = projectedVariants;
  console.log(`[style-embed] ${styleId}: ${descriptions.length} descriptions → centroid + ${projectedVariants.length} variants`);
}

writeFileSync(
  path.join(OUT_DIR, "style-embeddings.json"),
  JSON.stringify({
    version: "style-embeddings-v2",
    pcaVersion: "pca-embedding-v1",
    dims: 16,
    styles: styleEmbeddings,
    variants: styleEmbeddingVariants,
  }, null, 2) + "\n"
);
console.log(`[style-embed] ${Object.keys(styleEmbeddings).length} style embeddings → scripts/data/style-embeddings.json`);
