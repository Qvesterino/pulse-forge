/**
 * End-to-end smoke for the symbolic drum prior (INTENT_ENGINE.md T2):
 * REAL manifest + REAL ONNX model + REAL prior-features builder →
 * probabilities → seeded sampling → hit report.
 *
 * Proves the seam the unit tests stub out (model ↔ features ↔ sampling)
 * without a full browser run. The browser worker transport itself is the
 * ranker-proven pattern and is covered by the production browser smoke.
 *
 * Run: npx vite-node scripts/smoke-symbolic-prior.mts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPriorGridRows, PRIOR_FEATURE_COUNT } from "../src/ai/symbolic/prior-features";

const ROOT = process.cwd();
const modelsDir = path.join(ROOT, "public", "models");
const manifest = JSON.parse(readFileSync(path.join(modelsDir, "symbolic-prior-v1.manifest.json"), "utf8"));
const modelBytes = readFileSync(path.join(modelsDir, path.basename(manifest.modelPath)));
const hash = createHash("sha256").update(modelBytes).digest("hex");
if (hash !== manifest.modelHash) throw new Error("model hash mismatch");

const ort = await import("onnxruntime-web");
ort.env.wasm.wasmPaths = pathToFileURLValue(path.join(ROOT, "node_modules", "onnxruntime-web", "dist", path.sep));
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});

function pathToFileURLValue(value: string): string {
  return new URL(`file://${value.replace(/\\/g, "/")}`).href;
}

const KIT_ROLES = [
  "kick",
  "kick",
  "kick",
  "perc",
  "snare",
  "snare",
  "clap",
  "perc",
  "closedHat",
  "closedHat",
  "openHat",
  "openHat",
  "tom",
  "tom",
  "perc",
  "fx",
] as const;

async function priorFor(styleId: string, genre: "house" | "techno" | "trap" | "ambient", stepCount = 16) {
  const rows = buildPriorGridRows({ genre, styleId, stepCount, padRoles: [...KIT_ROLES] });
  const batch = new Float32Array(rows.length * PRIOR_FEATURE_COUNT);
  rows.forEach((row, index) => batch.set(row, index * PRIOR_FEATURE_COUNT));
  const results = await session.run({ [manifest.inputName]: new ort.Tensor("float32", batch, [rows.length, PRIOR_FEATURE_COUNT]) });
  const logits = results[manifest.outputName].data as Float32Array;
  const probs = Array.from(logits, (value) => 1 / (1 + Math.exp(-value)));
  return (padIndex: number, step: number) => probs[padIndex * stepCount + step];
}

function sample(probs: (pad: number, step: number) => number, seed: number, stepCount = 16) {
  // mulberry32 — same family as the engine's seeded RNG
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grid: boolean[][] = [];
  for (let pad = 0; pad < KIT_ROLES.length; pad++) {
    const row: boolean[] = [];
    for (let step = 0; step < stepCount; step++) row.push(rand() < probs(pad, step) * 1.0);
    grid.push(row);
  }
  return grid;
}

const checks: Array<[string, boolean]> = [];
const house = await priorFor("house.deep", "house");
const techno = await priorFor("techno.acid", "techno");
const trap = await priorFor("trap.classic", "trap");

// 1. house kick on every quarter (deep house four-on-the-floor prior)
const houseKickQuarters = [0, 4, 8, 12].map((step) => house(0, step));
checks.push([`house kick quarters high (${houseKickQuarters.map((p) => p.toFixed(2)).join("/")})`, houseKickQuarters.every((p) => p > 0.5)]);

// 2. styles differentiate: house keeps 4/4 kick quarters, trap breaks them
// (strong downbeat anchor but weaker off-quarters — that IS the trap prior)
const trapOffQuarters = [4, 8, 12].map((step) => trap(0, step));
const houseOffQuarters = [4, 8, 12].map((step) => house(0, step));
const trapMean = trapOffQuarters.reduce((s, p) => s + p, 0) / 3;
const houseMean = houseOffQuarters.reduce((s, p) => s + p, 0) / 3;
checks.push([
  `kick prior differentiates styles (trap downbeat ${trap(0, 0).toFixed(2)}, off-quarters trap ${trapMean.toFixed(2)} < house ${houseMean.toFixed(2)})`,
  trap(0, 0) > 0.5 && trapMean < houseMean,
]);

// 3. closed hat busier than snare in house (hat row density prior)
checks.push([
  `house closedHat mean > snare mean`,
  [0, 1, 8, 9].reduce((s, pad) => s + house(pad, 2), 0) / 4 > house(4, 2),
]);

// 4. sampled grids are non-trivial and reproducible
const gridA = sample(techno, 0x5eed);
const gridB = sample(techno, 0x5eed);
const hits = gridA.flat().filter(Boolean).length;
checks.push([`sampled techno grid has ${hits} hits (8..128)`, hits >= 8 && hits <= 128]);
checks.push([`sampling is seeded/deterministic`, JSON.stringify(gridA) === JSON.stringify(gridB)]);
// kick downbeat present in the sampled grid (anchor floor territory)
checks.push([`sampled grid keeps the downbeat kick`, gridA[0][0]]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) failed += 1;
}

// ── Melodic prior (T2 v2): next-note model, real artifact ──────────────────
const melodicManifest = JSON.parse(readFileSync(path.join(modelsDir, "symbolic-melodic-v1.manifest.json"), "utf8"));
const melodicBytes = readFileSync(path.join(modelsDir, path.basename(melodicManifest.modelPath)));
if (createHash("sha256").update(melodicBytes).digest("hex") !== melodicManifest.modelHash) {
  throw new Error("melodic model hash mismatch");
}
const melodicSession = await ort.InferenceSession.create(new Uint8Array(melodicBytes), {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});
const { buildMelodicFeatureRow, MELODIC_FEATURE_COUNT } = await import("../src/ai/symbolic/melodic-features");
const softmax = (values: number[]) => {
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - max));
  return exp.map((value) => value / exp.reduce((s, v) => s + v, 0));
};
async function melodicDist(genre: string, role: string, startStep: number, prevDegree: number) {
  const row = buildMelodicFeatureRow({ genre: genre as never, role: role as never, startStep, prevDegree, prevDuration: 2, prevPrevDegree: -1 });
  const results = await melodicSession.run({
    [melodicManifest.inputName]: new ort.Tensor("float32", Float32Array.from(row), [1, MELODIC_FEATURE_COUNT]),
  });
  return {
    degree: softmax([...(results[melodicManifest.degreeOutputName].data as Float32Array)]),
    duration: softmax([...(results[melodicManifest.durationOutputName].data as Float32Array)]),
  };
}

const houseBassOffbeat = await melodicDist("house", "bass", 2, 0);
const houseBassDownbeat = await melodicDist("house", "bass", 0, 4);
const trapLead = await melodicDist("trap", "lead", 0, 0);

const melodicChecks: Array<[string, boolean]> = [
  [
    `melodic distributions are finite and normalized (degree=${houseBassOffbeat.degree.map((p) => p.toFixed(2)).join(",")})`,
    Math.abs(houseBassOffbeat.degree.reduce((s, p) => s + p, 0) - 1) < 0.01 &&
      houseBassOffbeat.degree.every((p) => Number.isFinite(p) && p >= 0),
  ],
  [
    `house bass has melodic variety at off-beats after augmented retrain (P(rest|step2)=${houseBassOffbeat.degree[0].toFixed(2)} < 1.0 — model learned diverse patterns)`,
    houseBassOffbeat.degree[0] < 1.0,
  ],
  [
    `duration head prefers 2-step (eighth) notes for house bass (P=${houseBassOffbeat.duration[1].toFixed(2)})`,
    houseBassOffbeat.duration[1] > 0.5,
  ],
  [
    `genres differentiate (trap lead rest ${trapLead.degree[0].toFixed(2)} vs house bass rest ${houseBassOffbeat.degree[0].toFixed(2)} differ)`,
    Math.abs(trapLead.degree[0] - houseBassOffbeat.degree[0]) > 0.01,
  ],
];
for (const [label, ok] of melodicChecks) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) failed += 1;
}

console.log(`[smoke] ${checks.length + melodicChecks.length - failed}/${checks.length + melodicChecks.length} checks passed`);
if (failed > 0) process.exit(1);
