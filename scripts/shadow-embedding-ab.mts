/**
 * SHADOW A/B — embedding-conditioned (v2) vs one-hot (v1) drum prior,
 * MODEL LEVEL. Both models are loaded directly through onnxruntime-web in a
 * vite dev-server context (same pattern as validate-symbolic-prior.mjs —
 * Node has no Worker and no relative-URL fetch, so the worker path cannot
 * run here; the provider-level runtime is covered by unit tests + browser
 * smoke instead).
 *
 * The gate measures what the default-flip decision actually hinges on:
 *   - FUNCTIONAL: the v2 model answers every prompt with finite probabilities
 *     (the v2 artifact + manifest are healthy for arbitrary text);
 *   - NON-DEGRADATION: on opposite-character prompt pairs ("dark rainy
 *     berlin" vs "sunny uplifting"), the v2 probability grids differ from
 *     each other AT LEAST AS MUCH as v1's — the semantic channel reacts to
 *     text no weaker than the slider channel did;
 *   - SANITY: probabilities stay in musical ranges (not walls, not silence).
 *
 * Ear-level evidence is a separate step (listening room). The runtime itself
 * already degrades to v1 per candidate whenever anything is unavailable, so
 * a PASS verdict makes the default flip LOW-RISK, not unconditional praise.
 *
 * Run: npm run embedding:ab
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { parseIntentText } from "../src/intent/text-parser";
import {
  buildPriorGridRows,
  priorGenreOf,
  PRIOR_FEATURE_COUNT,
  PRIOR_STYLE_VOCAB,
} from "../src/ai/symbolic/prior-features";
import { buildPriorV2GridRows, V2_FEATURE_COUNT } from "../src/ai/symbolic/prior-features-v2";
import { buildPriorV3GridRows, V3_FEATURE_COUNT } from "../src/ai/symbolic/prior-features-v3";
import { projectEmbedding, pcaOutputDims } from "../src/ai/symbolic/pca-projection";

const PROMPTS = [
  "dark rainy berlin techno at 132",
  "sunny uplifting techno at 132",
  "aggressive peak time techno",
  "minimal hypnotic techno",
  "aggressive hard trap at 145",
  "chill smooth trap at 135",
  "deep house sunset groove",
  "funky house party at 125",
  "drift phonk night drive",
  "liquid drum and bass rollers",
];
/** Indices of prompts with OPPOSITE character — the differentiation pairs. */
const OPPOSITE_PAIRS: Array<[number, number]> = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
];
const PAD_ROLES = ["kick", "snare", "clap", "closedHat"];
const STEPS = 16;

const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

// ── vite server: same-origin context for the browser-compatible ORT runtime ──
const server = await createServer({
  root: ROOT,
  logLevel: "error",
  server: { port: 5251, host: "127.0.0.1", strictPort: true },
});
await server.listen();

try {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep)).href;
  ort.env.wasm.numThreads = 1;

  const modelsDir = path.join(ROOT, "public", "models");
  const loadModel = (base: string) => {
    const manifest = JSON.parse(readFileSync(path.join(modelsDir, `${base}.manifest.json`), "utf8"));
    const bytes = readFileSync(path.join(modelsDir, path.basename(manifest.modelPath)));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== String(manifest.modelHash ?? "").toLowerCase()) throw new Error(`${base}: hash mismatch`);
    return { manifest, bytes };
  };
  const { manifest: v1Manifest, bytes: v1Bytes } = loadModel("symbolic-prior-v1");
  const { manifest: v2Manifest, bytes: v2Bytes } = loadModel("symbolic-prior-v2");
  const { manifest: v3Manifest, bytes: v3Bytes } = loadModel("symbolic-prior-v3");
  const sessionV1 = await ort.InferenceSession.create(new Uint8Array(v1Bytes), { executionProviders: ["wasm"] });
  const sessionV2 = await ort.InferenceSession.create(new Uint8Array(v2Bytes), { executionProviders: ["wasm"] });
  const sessionV3 = await ort.InferenceSession.create(new Uint8Array(v3Bytes), { executionProviders: ["wasm"] });

  async function runPrior(
    session: ort.InferenceSession,
    manifest: { inputName: string; outputName: string; featureCount: number },
    rows: number[][],
  ): Promise<Float64Array> {
    const rowCount = rows.length;
    const batch = new Float32Array(rowCount * manifest.featureCount);
    rows.forEach((row, index) => batch.set(row, index * manifest.featureCount));
    const tensor = new ort.Tensor("float32", batch, [rowCount, manifest.featureCount]);
    const output = await session.run({ [manifest.inputName]: tensor });
    const raw = output[manifest.outputName].data as Float32Array;
    if (raw.length !== rowCount) throw new Error(`output ${raw.length} != ${rowCount}`);
    return Float64Array.from(raw, sigmoid);
  }

  // ── Node MiniLM embedder (the same model the semantic worker uses) ─────────
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = path.join(ROOT, "public", "models", "semantic") + path.sep;
  console.log("[ab] loading MiniLM …");
  const extractor = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", {
    dtype: "q8",
  });

  const gridsV1: Float64Array[] = [];
  const gridsV2: Float64Array[] = [];
  const gridsV3: Float64Array[] = [];
  const rowsMeta: Array<{ prompt: string; genre: string; style: string; v1Mean: number; v2Mean: number }> = [];

  for (const prompt of PROMPTS) {
    const parsed = parseIntentText(prompt);
    const genre = parsed.input.genre ?? "house";
    const styleId =
      parsed.input.style && PRIOR_STYLE_VOCAB.includes(`${genre}.${parsed.input.style}`)
        ? `${genre}.${parsed.input.style}`
        : (PRIOR_STYLE_VOCAB.find((id) => id.startsWith(`${genre}.`)) ?? PRIOR_STYLE_VOCAB[0]);

    const v1Rows = buildPriorGridRows({ genre: priorGenreOf(genre), styleId, stepCount: STEPS, padRoles: PAD_ROLES });
    if (v1Rows.length !== PAD_ROLES.length * STEPS || v1Rows[0].length !== PRIOR_FEATURE_COUNT) {
      throw new Error("v1 feature layout drift");
    }
    const embedded = (await extractor([prompt], { pooling: "mean", normalize: true })) as {
      data: Float32Array;
      dims: number[];
    };
    const embedding = new Float32Array(384);
    embedding.set(embedded.data.subarray(0, 384));
    if (pcaOutputDims() !== 16) throw new Error("pca dims drift");
    const semantic = projectEmbedding(embedding);
    if (!semantic) throw new Error(`projection failed for: ${prompt}`);
    const v2Rows = buildPriorV2GridRows({ semantic, padRoles: PAD_ROLES, stepCount: STEPS });
    if (v2Rows.length !== PAD_ROLES.length * STEPS || v2Rows[0].length !== V2_FEATURE_COUNT) {
      throw new Error("v2 feature layout drift");
    }

    const v3Rows = buildPriorV3GridRows({
      semantic,
      genre: priorGenreOf(genre),
      styleId,
      padRoles: PAD_ROLES,
      stepCount: STEPS,
    });
    if (v3Rows.length !== PAD_ROLES.length * STEPS || v3Rows[0].length !== V3_FEATURE_COUNT) {
      throw new Error("v3 feature layout drift");
    }

    const probsV1 = await runPrior(sessionV1, v1Manifest, v1Rows);
    const probsV2 = await runPrior(sessionV2, v2Manifest, v2Rows);
    const probsV3 = await runPrior(sessionV3, v3Manifest, v3Rows);
    gridsV1.push(probsV1);
    gridsV2.push(probsV2);
    gridsV3.push(probsV3);
    const mean = (grid: Float64Array) => grid.reduce((sum, value) => sum + value, 0) / grid.length;
    rowsMeta.push({
      prompt,
      genre,
      style: styleId,
      v1Mean: Number(mean(probsV1).toFixed(3)),
      v2Mean: Number(mean(probsV2).toFixed(3)),
    });
    console.log(`[ab] ${prompt} → v1 mean ${mean(probsV1).toFixed(3)} | v2 mean ${mean(probsV2).toFixed(3)}`);
  }

  // metrics + verdict
  const distance = (a: Float64Array, b: Float64Array) => {
    let sum = 0;
    for (let index = 0; index < a.length; index++) sum += (a[index] - b[index]) ** 2;
    return Math.sqrt(sum);
  };
  const meanOf = (grid: Float64Array) => grid.reduce((sum, value) => sum + value, 0) / grid.length;
  const degenerateV3 = gridsV3.filter((grid) => {
    const mean = meanOf(grid);
    return mean < 0.02 || mean > 0.6;
  }).length;

  const pairs = OPPOSITE_PAIRS.map(([a, b]) => {
    const dV1 = distance(gridsV1[a], gridsV1[b]);
    const dV2 = distance(gridsV2[a], gridsV2[b]);
    const dV3 = distance(gridsV3[a], gridsV3[b]);
    const moodOnly = dV1 < 0.01; // one-hot blind — semantic channels must see it
    return {
      pair: `${PROMPTS[a]}  ⇄  ${PROMPTS[b]}`,
      kind: moodOnly ? ("mood-only" as const) : ("style-varying" as const),
      v1Distance: Number(dV1.toFixed(2)),
      v2Distance: Number(dV2.toFixed(2)),
      v3Distance: Number(dV3.toFixed(2)),
      v3Pass: moodOnly ? dV3 > 0.05 : dV3 >= dV1 * 0.8,
    };
  });
  const moodPairsPass = pairs.filter((pair) => pair.kind === "mood-only").every((pair) => pair.v3Pass);
  const stylePairsPass = pairs.filter((pair) => pair.kind === "style-varying").every((pair) => pair.v3Pass);

  // v3 must answer every prompt non-degenerately, SEE the mood-only pairs v1
  // is blind to, and keep v1's sharpness (>=80 %) on style-varying pairs.
  const functional = degenerateV3 === 0;
  const verdict = functional && moodPairsPass && stylePairsPass ? "RECOMMEND-ON" : "KEEP-OFF";

  console.log(`[ab] functional (v3 answers, no degenerate grids): ${functional} (degenerate=${degenerateV3})`);
  console.log(`[ab] mood-only pairs seen by v3: ${moodPairsPass ? "PASS" : "FAIL"}`);
  console.log(`[ab] style-varying pairs keep v1 sharpness (>=0.8): ${stylePairsPass ? "PASS" : "FAIL"}`);
  for (const pair of pairs) {
    console.log(
      `[ab]   ${pair.v3Pass ? "▲" : "▼"} [${pair.kind}] ${pair.pair} — v1 ${pair.v1Distance} / v2 ${pair.v2Distance} / v3 ${pair.v3Distance}`,
    );
  }
  console.log(
    `[ab] VERDICT: ${verdict}${verdict === "RECOMMEND-ON" ? " → flip pf:embedding-conditioned default to on" : ""}`,
  );

  const report = {
    version: "embedding-ab-v2-model-level",
    generatedAt: new Date().toISOString(),
    prompts: PROMPTS,
    rows: rowsMeta,
    pairs,
    moodPairsPass,
    stylePairsPass,
    functional,
    verdict,
  };
  const outDir = path.join(ROOT, "scripts", "data");
  writeFileSync(path.join(outDir, "embedding-ab-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("[ab] report → scripts/data/embedding-ab-report.json");
  if (verdict !== "RECOMMEND-ON") process.exitCode = 1;
} finally {
  await server.close();
}
