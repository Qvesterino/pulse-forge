/**
 * Intent ranker trainer (goal doc Fáze 2) — offline development tooling.
 *
 * Pure Node, zero npm dependencies:
 *  1. loads scripts/data/intent-ranker-dataset.json (features.v1 vectors +
 *     heuristic teacher scores),
 *  2. trains a tiny pairwise MLP (RankNet-style logistic loss on
 *     better/worse pairs; heuristic score is the TEACHER signal, never proof
 *     of musical quality),
 *  3. serializes the trained weights as a minimal ONNX graph
 *     (Gemm+Relu ×3 → Gemm; input [N, featureCount] → output [N, 1]),
 *  4. writes public/models/intent-ranker-v1.onnx + manifest + a validation
 *     report (train/val pairwise accuracy vs the heuristic teacher, top-1
 *     agreement, Spearman rank correlation on held-out groups).
 *
 * Split is by GROUP (seed × style) — no leakage between train and val.
 *
 * Run: node scripts/train-intent-ranker.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = path.join(ROOT, "scripts", "data", "intent-ranker-dataset.json");
const modelsDir = path.join(ROOT, "public", "models");

const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const featureNames = dataset.featureNames ?? null;
const HIDDEN = [64, 32, 16];
const EPOCHS = 150;
const LEARNING_RATE = 0.08;
const SEED = 0x5eed;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

// ── flatten dataset ──
const samples = [];
for (const group of dataset.groups) {
  const rows = group.candidates.map((candidate) => ({
    x: candidate.features,
    score: candidate.heuristicScore,
    index: candidate.index,
    groupKey: group.groupKey,
  }));
  samples.push(...rows);
}
const featureCount = samples[0]?.x.length ?? 0;
if (!featureCount) throw new Error("empty dataset");
if (featureNames && featureNames.length !== featureCount) throw new Error("feature count mismatch");

// deterministic group split: 80% train / 20% val by group hash
const groupKeys = [...new Set(samples.map((s) => s.groupKey))].sort();
const valKeys = new Set();
for (const [i, key] of groupKeys.entries()) if (i % 5 === 0) valKeys.add(key);
const train = samples.filter((s) => !valKeys.has(s.groupKey));
const val = samples.filter((s) => valKeys.has(s.groupKey));
console.log(`[train] samples total=${samples.length} train=${train.length} val=${val.length} features=${featureCount}`);

// ── tiny MLP forward/backward (RankNet pairwise logistic loss) ──
const layers = [];
let prevSize = featureCount;
for (const size of [...HIDDEN, 1]) {
  layers.push({
    w: Array.from({ length: size }, () => Array.from({ length: prevSize }, () => (rng() - 0.5) * 0.4)),
    b: new Array(size).fill(0),
    mW: new Array(size).fill(0).map(() => new Array(prevSize).fill(0)),
    mB: new Array(size).fill(0),
  });
  prevSize = size;
}

function forward(x, weights = layers) {
  const activations = [x];
  let current = x;
  for (let l = 0; l < weights.length; l++) {
    const layer = weights[l];
    const out = new Array(layer.w.length);
    const isLast = l === weights.length - 1;
    for (let j = 0; j < layer.w.length; j++) {
      let sum = layer.b[j];
      const row = layer.w[j];
      for (let k = 0; k < current.length; k++) sum += row[k] * current[k];
      out[j] = isLast ? sum : Math.max(0, sum); // ReLU hidden, linear output
    }
    activations.push(out);
    current = out;
  }
  return activations;
}

function trainPair(xBetter, xWorse, lr) {
  const actB = forward(xBetter);
  const actW = forward(xWorse);
  const diff = actB[actB.length - 1][0] - actW[actW.length - 1][0];
  // -log sigmoid(diff); dLoss/dDiff = -sigmoid(-diff) = -1/(1+e^diff)
  const grad = -1 / (1 + Math.exp(diff));
  // backprop both paths with ±grad on the output pre-activation
  for (const [activation, sign] of [
    [actB, grad],
    [actW, -grad],
  ]) {
    let delta = new Array(activation[activation.length - 1].length).fill(sign);
    for (let l = layers.length - 1; l >= 0; l--) {
      const layer = layers[l];
      const input = activation[l];
      const nextDelta = new Array(input.length).fill(0);
      for (let j = 0; j < layer.w.length; j++) {
        const g = delta[j];
        const row = layer.w[j];
        for (let k = 0; k < input.length; k++) {
          nextDelta[k] += row[k] * g;
          layer.mW[j][k] += g * input[k];
          // ReLU derivative on hidden layers only
          if (l > 0 && input[k] <= 0) nextDelta[k] = 0;
        }
        layer.mB[j] += g;
      }
      delta = nextDelta;
    }
  }
  return Math.log(1 + Math.exp(Math.min(30, diff)));
}

// build deterministic pairwise list
function pairsFor(rows) {
  const pairs = [];
  for (const groupKey of [...new Set(rows.map((r) => r.groupKey))].sort()) {
    const groupRows = rows.filter((r) => r.groupKey === groupKey);
    for (let a = 0; a < groupRows.length; a++) {
      for (let b = a + 1; b < groupRows.length; b++) {
        const better = groupRows[a].score >= groupRows[b].score ? groupRows[a] : groupRows[b];
        const worse = better === groupRows[a] ? groupRows[b] : groupRows[a];
        if (better.score !== worse.score) pairs.push([better.x, worse.x]);
      }
    }
  }
  return pairs.sort((p, q) => JSON.stringify(p[0]).localeCompare(JSON.stringify(q[0])));
}

const trainPairs = pairsFor(train);
const valPairs = pairsFor(val);
console.log(`[train] pairs train=${trainPairs.length} val=${valPairs.length}`);

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  let loss = 0;
  const shuffled = [...trainPairs];
  const shuffleRng = mulberry32(SEED + epoch);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const lr = LEARNING_RATE;
  for (const [xB, xW] of shuffled) loss += trainPair(xB, xW, lr);
  // apply accumulated gradients
  const scale = (1 / shuffled.length) * lr;
  for (const layer of layers) {
    for (let j = 0; j < layer.w.length; j++) {
      for (let k = 0; k < layer.w[j].length; k++) {
        layer.w[j][k] -= scale * layer.mW[j][k];
        layer.mW[j][k] = 0;
      }
      layer.b[j] -= scale * layer.mB[j];
      layer.mB[j] = 0;
    }
  }
  if (epoch % 100 === 0 || epoch === EPOCHS - 1) console.log(`[train] epoch ${epoch} loss=${(loss / shuffled.length).toFixed(5)}`);
}

// ── validation: does the model AGREE with the teacher on held-out pairs? ──
function modelScore(x) {
  const activation = forward(x);
  return activation[activation.length - 1][0];
}
function pairwiseAccuracy(rows) {
  const pairs = pairsFor(rows);
  let agree = 0;
  for (const [xB, xW] of pairs) if (modelScore(xB) > modelScore(xW)) agree += 1;
  return pairs.length > 0 ? agree / pairs.length : 1;
}
function top1Agreement(rows) {
  const groupKeys = [...new Set(rows.map((r) => r.groupKey))].sort();
  let agree = 0;
  let total = 0;
  for (const groupKey of groupKeys) {
    const groupRows = rows.filter((r) => r.groupKey === groupKey);
    if (groupRows.length < 2) continue;
    const bestHeuristic = [...groupRows].sort((a, b) => b.score - a.score)[0];
    const bestModel = [...groupRows].sort((a, b) => modelScore(b.x) - modelScore(a.x))[0];
    if (bestHeuristic.index === bestModel.index) agree += 1;
    total += 1;
  }
  return total > 0 ? agree / total : 1;
}
function spearman(rows) {
  const groupKeys = [...new Set(rows.map((r) => r.groupKey))].sort();
  let sumRho = 0;
  let count = 0;
  for (const groupKey of groupKeys) {
    const groupRows = rows.filter((r) => r.groupKey === groupKey);
    if (groupRows.length < 3) continue;
    const byHeuristic = [...groupRows].sort((a, b) => b.score - a.score).map((r) => r.index);
    const byModel = [...groupRows].sort((a, b) => modelScore(b.x) - modelScore(a.x)).map((r) => r.index);
    const d2 = byHeuristic.reduce((sum, index, rank) => sum + (byModel.indexOf(index) - rank) ** 2, 0);
    const n = groupRows.length;
    sumRho += 1 - (6 * d2) / (n * (n * n - 1));
    count += 1;
  }
  return count > 0 ? sumRho / count : 1;
}

const report = {
  datasetVersion: dataset.datasetVersion,
  featureVersion: "features.v1",
  featureCount,
  hidden: HIDDEN,
  epochs: EPOCHS,
  trainPairs: trainPairs.length,
  valPairs: valPairs.length,
  valPairwiseAccuracyVsHeuristic: Number(pairwiseAccuracy(val).toFixed(4)),
  trainPairwiseAccuracyVsHeuristic: Number(pairwiseAccuracy(train).toFixed(4)),
  valTop1AgreementWithHeuristic: Number(top1Agreement(val).toFixed(4)),
  valSpearmanVsHeuristic: Number(spearman(val).toFixed(4)),
};
console.log("[train] report:", JSON.stringify(report, null, 2));

// ── minimal ONNX protobuf writer (float32, Gemm+Relu graph) ──
function varint(value) {
  const bytes = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}
function tag(field, wireType) {
  return varint((field << 3) | wireType);
}
function lenDelimited(field, payload) {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}
function strField(field, text) {
  return lenDelimited(field, [...Buffer.from(text, "utf8")]);
}
function floatField(field, value) {
  const bytes = [];
  new DataView(new ArrayBuffer(4)).constructor;
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  for (let i = 0; i < 4; i++) bytes.push(view.getUint8(i));
  return [...tag(field, 5), ...bytes];
}
function int64Field(field, value) {
  return [...tag(field, 0), ...varint(value)];
}

function tensor(name, dims, data) {
  const out = [...strField(8, name)];
  for (const dim of dims) out.push(...tag(1, 0), ...varint(dim));
  out.push(...tag(2, 0), ...varint(1)); // data_type FLOAT
  out.push(...tag(9, 2), ...varint(data.length * 4));
  const view = new DataView(new ArrayBuffer(4));
  for (const f of data) {
    view.setFloat32(0, f, true);
    for (let i = 0; i < 4; i++) out.push(view.getUint8(i));
  }
  return out;
}
function node(opType, name, inputs, outputs, attrs = []) {
  let out = [];
  for (const input of inputs) out.push(...strField(1, input));
  for (const output of outputs) out.push(...strField(2, output));
  out.push(...strField(3, name));
  out.push(...strField(4, opType));
  // AttributeProto: name=1 (string), f=2 (float), i=3 (int64)
  for (const attr of attrs) out.push(...lenDelimited(5, attr));
  return lenDelimited(1, out);
}
function attrF(name, value) {
  return [...strField(1, name), ...floatField(2, value)];
}
function attrI(name, value) {
  return [...strField(1, name), ...int64Field(3, value)];
}
function valueInfoField(field, name, dims) {
  const shape = [];
  for (const dim of dims) shape.push(...lenDelimited(1, [...tag(1, 0), ...varint(dim)]));
  const tensorType = [...tag(1, 0), ...varint(1), ...lenDelimited(2, lenDelimited(1, shape))];
  return lenDelimited(field, [...strField(1, name), ...lenDelimited(2, lenDelimited(1, tensorType))]);
}

const graphName = "intent-ranker-v1";
const graphNodes = [];
const graphInitializers = [];
const dimsFor = (size) => [1, size];
let current = "features";
let index = 0;
for (let l = 0; l < layers.length; l++) {
  const size = layers[l].w.length;
  const flat = layers[l].w.flat();
  graphInitializers.push(tensor(`W${l}`, [size, layers[l].w[0].length], flat));
  graphInitializers.push(tensor(`B${l}`, [size], layers[l].b));
  const gemmOut = `gemm${l}`;
  graphNodes.push(
    node(
      "Gemm",
      `gemm_${l}`,
      [current, `W${l}`, `B${l}`],
      [gemmOut],
      [attrF("alpha", 1.0), attrF("beta", 1.0), attrI("transA", 0), attrI("transB", 1)],
    ),
  );
  current = gemmOut;
  if (l < layers.length - 1) {
    const reluOut = `relu${l}`;
    graphNodes.push(node("Relu", `relu_${l}`, [current], [reluOut]));
    current = reluOut;
  }
  index += 1;
}
void index;
const graph = [
  ...graphNodes,
  ...lenDelimited(2, [...strField(1, graphName)]),
  ...graphInitializers.flatMap((init) => lenDelimited(5, init)),
  ...valueInfoField(11, "features", dimsFor(featureCount)),
  ...valueInfoField(12, "score", dimsFor(1)),
];
const model = [
  ...int64Field(1, 8),
  ...strField(2, "pulse-forge-intent-trainer"),
  ...lenDelimited(7, graph),
  ...lenDelimited(8, [...strField(1, ""), ...int64Field(2, 13)]),
];

mkdirSync(modelsDir, { recursive: true });
const onnxPath = path.join(modelsDir, "intent-ranker-v1.onnx");
writeFileSync(onnxPath, Buffer.from(model));
const { createHash } = await import("node:crypto");
const modelHash = createHash("sha256").update(Buffer.from(model)).digest("hex");
console.log(`[train] model written ${onnxPath} (${(model.length / 1024).toFixed(1)} kB) sha256=${modelHash.slice(0, 16)}…`);

const manifest = {
  rankerVersion: "ranker.v1",
  featureVersion: "features.v1",
  normalizationId: "norm.fixed.v1",
  featureCount,
  modelPath: "/models/intent-ranker-v1.onnx",
  inputName: "features",
  outputName: "score",
  modelHash,
  hidden: HIDDEN,
  report,
};
writeFileSync(path.join(modelsDir, "intent-ranker-v1.manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(ROOT, "scripts", "data", "intent-ranker-validation.json"), JSON.stringify(report, null, 2));
console.log("[train] manifest written");
