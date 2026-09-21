/**
 * Generates src/ai/symbolic/pca-projection.ts from
 * scripts/data/pca-embedding-projection.json (Fáza C → F runtime bridge).
 *
 * The PCA matrix (mean 384 + 16×384 components) must be available in the
 * BROWSER bundle — scripts/data/ is not served. Raw floats would add ~130 kB;
 * Int8-per-row quantization + base64 lands at ~9 kB with ≤ scale/127 error
 * per entry (≈0.4 % of a component's magnitude), far below the semantic
 * spread the conditioned prior consumes.
 *
 * Deterministic: same JSON ⇒ same module bytes. Checked in together with the
 * PCA JSON; re-run only when the projection is retrained.
 *
 * Run: node scripts/generate-pca-projection-module.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "scripts", "data", "pca-embedding-projection.json");
const TARGET = path.join(ROOT, "src", "ai", "symbolic", "pca-projection.ts");

const payload = JSON.parse(readFileSync(SOURCE, "utf8"));
const { version, inputDims, outputDims, mean, components } = payload;
if (!Array.isArray(mean) || mean.length !== inputDims) throw new Error("mean dims mismatch");
if (!Array.isArray(components) || components.length !== outputDims) throw new Error("component count mismatch");
for (const component of components) {
  if (!Array.isArray(component) || component.length !== inputDims) throw new Error("component dims mismatch");
}

/** Quantize one row: per-row max-abs scale, Int8 centered at 128, base64. */
function quantize(row) {
  let maxAbs = 0;
  for (const value of row) maxAbs = Math.max(maxAbs, Math.abs(value));
  const scale = maxAbs === 0 ? 0 : maxAbs / 127;
  const bytes = Buffer.alloc(row.length);
  for (let index = 0; index < row.length; index++) bytes[index] = Math.round(row[index] / (scale || 1)) + 128;
  return { scale, b64: bytes.toString("base64") };
}

const meanQ = quantize(mean);
const componentsQ = components.map(quantize);
const sourceHash = createHash("sha256").update(readFileSync(SOURCE)).digest("hex").slice(0, 16);

const file = `/**
 * PCA projection (384 → 16) for embedding-conditioned priors — GENERATED FILE.
 * Source: scripts/data/pca-embedding-projection.json (${version}, sha256:${sourceHash}…).
 * Regenerate: npm run pca:module. Do not edit by hand.
 *
 * Rows are Int8-quantized (per-row max-abs scale) and base64-packed to keep
 * the runtime bundle small (~9 kB vs ~130 kB raw floats); dequantization
 * error is ≤ scale/127 per entry (≈0.4 % of a component's magnitude), far
 * below the semantic spread the conditioned prior consumes.
 */

const PCA_VERSION = ${JSON.stringify(version)};
const PCA_INPUT_DIMS = ${inputDims};
const PCA_OUTPUT_DIMS = ${outputDims};

const MEAN_SCALE = ${meanQ.scale.toExponential(17)};
const MEAN_B64 = ${JSON.stringify(meanQ.b64)};
const COMPONENT_SCALES = [
${componentsQ.map((entry) => `  ${entry.scale.toExponential(17)},`).join("\n")}
];
const COMPONENTS_B64 = [
${componentsQ.map((entry) => `  ${JSON.stringify(entry.b64)},`).join("\n")}
];

function dequantizeRow(b64: string, scale: number, dims: number): Float64Array {
  const bytes = globalThis.atob(b64);
  const row = new Float64Array(dims);
  for (let index = 0; index < dims; index++) row[index] = (bytes.charCodeAt(index) - 128) * scale;
  return row;
}

let decodedMean: Float64Array | null = null;
let decodedComponents: Float64Array[] | null = null;

function ensureDecoded(): void {
  if (decodedMean && decodedComponents) return;
  decodedMean = dequantizeRow(MEAN_B64, MEAN_SCALE, PCA_INPUT_DIMS);
  decodedComponents = COMPONENTS_B64.map((b64, index) =>
    dequantizeRow(b64, COMPONENT_SCALES[index], PCA_INPUT_DIMS),
  );
}

export function pcaVersion(): string {
  return PCA_VERSION;
}

export function pcaInputDims(): number {
  return PCA_INPUT_DIMS;
}

export function pcaOutputDims(): number {
  return PCA_OUTPUT_DIMS;
}

/**
 * Project a 384-dim L2-normalized MiniLM embedding onto the 16 principal
 * components. Returns null for wrong-dim or non-finite input — callers fall
 * back to the v1 one-hot prior. Pure: same vector ⇒ same projection.
 */
export function projectEmbedding(vector: ArrayLike<number>): number[] | null {
  ensureDecoded();
  if (!vector || vector.length !== PCA_INPUT_DIMS) return null;
  const centered = new Float64Array(PCA_INPUT_DIMS);
  for (let index = 0; index < PCA_INPUT_DIMS; index++) {
    const value = vector[index];
    if (!Number.isFinite(value)) return null;
    centered[index] = value - decodedMean[index];
  }
  const out = new Array<number>(PCA_OUTPUT_DIMS);
  for (let component = 0; component < PCA_OUTPUT_DIMS; component++) {
    const weights = decodedComponents[component];
    let sum = 0;
    for (let index = 0; index < PCA_INPUT_DIMS; index++) sum += weights[index] * centered[index];
    out[component] = sum;
  }
  return out;
}
`;

writeFileSync(TARGET, file);
const kb = (file.length / 1024).toFixed(1);
console.log(`[pca:module] wrote ${path.relative(ROOT, TARGET)} (${kb} kB, ${version}, sha256:${sourceHash}…)`);
