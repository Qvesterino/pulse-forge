/**
 * W2 — APPEND public-domain-classical style vectors to style-embeddings.json.
 *
 * The MIDI corpus is trained with its OWN conditioning region so classical
 * material can never contaminate an electronic genre's centroid (a shared
 * `ambient` prefix measurably hurt degree accuracy on the ds.v3 gate — the
 * corpus taught the model "ambient = baroque counterpoint").
 *
 * These vectors are used ONLY as TRAINING conditioning for the corpus rows
 * (group prefix `classical.<era>#midi:<piece>#<role>`). Nothing at runtime
 * requests a classical style today; the region exists so the corpus's
 * contribution lands in its own neighbourhood of the PCA space instead of
 * stealing weight from the 19 shipped genres.
 *
 * APPEND-ONLY by construction: existing style/variant entries are copied
 * through byte-identical, so the shipped priors' conditioning is unchanged
 * (the v2 retrain only sees a wider lookup table; every pre-existing
 * `style_id` resolves to the exact same vector as before).
 *
 * Run: npx vite-node scripts/append-classical-embeddings.mts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { transform, pipeline, env } from "@huggingface/transformers";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "scripts", "data");
const PCA = JSON.parse(readFileSync(path.join(OUT_DIR, "pca-embedding-projection.json"), "utf8"));
const pcaMean = Float64Array.from(PCA.mean);
const pcaComponents = PCA.components;

/** Project a 384-dim embedding through the committed PCA to 16 dims. */
function project(embedding: Float32Array | number[]): number[] {
  const e = Float64Array.from(embedding);
  const centered = e.map((v, d) => v - pcaMean[d]);
  return pcaComponents.map((comp) => comp.reduce((sum, c, d) => sum + c * centered[d], 0));
}

/**
 * Per-era descriptions. Hand-written rather than generated: the shared
 * `generateDescriptions` templates are beat-oriented ("grooves", "roller")
 * and would place a Bach chorale next to a techno roller in PCA space. These
 * strings describe the actual musical material.
 */
const CLASSICAL_DESCRIPTIONS: Record<string, string[]> = {
  baroque: [
    "baroque counterpoint, four-part chorale harmony",
    "imitation and invertible counterpoint, basso continuo line",
    "choral sacred harmony, strict voice leading",
    "fugue subject and answer, sequential imitation",
    "harpsichord continuo texture, walking bass line",
    "ornamented melodic line over steady harmonic motion",
    "biblical chorale tune, simple stepwise melody",
  ],
  classical: [
    "classical period chamber writing, balanced phrasing",
    "symmetrical melody and cadence, galant style",
    "accompanied song, melody over sparse accompaniment",
    "eighteenth-century divertimento, graceful melodic writing",
  ],
  romantic: [
    "romantic piano nocturne, singing lyrical melody",
    "expressive chromatic melody, wide expressive intervals",
    "lyrical cantabile line with accompaniment",
    "post-chromatic harmony, rich inner voices",
    "rhapsodic variation, thematic transformation",
  ],
  impressionist: [
    "impressionist piano texture, whole-tone and modal colour",
    "arpeggiated figuration, shimmering harmony",
    "atmospheric modal melody, colour over function",
  ],
  modern: [
    "twentieth-century atonal writing, twelve-tone line",
    "serial melody without tonal centre",
  ],
};

async function main(): Promise<void> {
  const packPath = path.join(OUT_DIR, "style-embeddings.json");
  if (!existsSync(packPath)) throw new Error(`style-embeddings.json missing — run npm run semantic:embeddings first`);
  const pack = JSON.parse(readFileSync(packPath, "utf8")) as {
    version: string;
    pcaVersion: string;
    dims: number;
    styles: Record<string, number[]>;
    variants: Record<string, number[][]>;
  };

  // Skip work that is already done (idempotent re-runs).
  const wanted = Object.keys(CLASSICAL_DESCRIPTIONS).filter((era) => !pack.styles[`classical.${era}`]);
  if (wanted.length === 0) {
    console.log(`[classical-embed] already present: ${Object.keys(CLASSICAL_DESCRIPTIONS).join(", ")}`);
    return;
  }

  console.log(`[classical-embed] loading MiniLM …`);
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = path.join(ROOT, "public", "models", "semantic") + path.sep;
  const extractor = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", {
    dtype: "q8",
  });

  for (const era of wanted) {
    const descriptions = CLASSICAL_DESCRIPTIONS[era];
    const output = (await extractor(descriptions, { pooling: "mean", normalize: true })) as {
      data: Float32Array;
      dims: number[];
    };
    const [rows, dim] = output.dims;
    const variants: number[][] = [];
    const avg = new Float64Array(dim);
    for (let r = 0; r < rows; r++) {
      const vec = output.data.slice(r * dim, (r + 1) * dim);
      for (let d = 0; d < dim; d++) avg[d] += vec[d] / rows;
      variants.push(project(vec));
    }
    const styleId = `classical.${era}`;
    pack.styles[styleId] = project(avg);
    pack.variants[styleId] = variants;
    console.log(`[classical-embed] ${styleId}: ${descriptions.length} descriptions → centroid + ${variants.length} variants`);
  }

  writeFileSync(packPath, JSON.stringify(pack, null, 0));
  console.log(`[classical-embed] pack now has ${Object.keys(pack.styles).length} styles → ${packPath}`);
}

await main();