/**
 * S4 — OWNER VALIDATION for the fetched htdemucs checkpoint: runs the model
 * on a deterministic synthetic fixture, checks the output contract, and —
 * with --pin — flips `gatePassed` in the manifest (the audio-tag ritual:
 * a candidate becomes an actor ONLY after this pass).
 *
 * Run: npm run stem:validate        (checks, prints the report)
 *      npm run stem:validate -- --pin
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public", "models", "stem");
const manifestPath = path.join(OUT, "manifest.json");
const pin = process.argv.includes("--pin");

if (!existsSync(manifestPath)) {
  console.error("[stem:validate] no manifest — run `npm run stem:fetch` first.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const modelPath = path.join(OUT, manifest.modelFile);
if (!existsSync(modelPath)) {
  console.error(`[stem:validate] model file missing: ${manifest.modelFile}`);
  process.exit(1);
}

const SR = manifest.sampleRate ?? 44100;
const chunkSec = manifest.chunkSec ?? 7.8;
const samples = Math.floor(chunkSec * SR);
// Synthetic fixture: 220 Hz tone (harmonic) + 60→110 Hz sweep burst (bass-ish)
// + noise — enough structure to prove the model ran and produced stems.
const chunk = new Float32Array(samples);
for (let i = 0; i < samples; i++) {
  const t = i / SR;
  chunk[i] =
    0.3 * Math.sin(2 * Math.PI * 220 * t) +
    0.25 * Math.sin(2 * Math.PI * (60 + 50 * Math.min(1, t / chunkSec)) * t) * (t < 1 ? 1 : 0.2) +
    0.02 * ((Math.sin(i * 12.9898) * 43758.5453) % 1);
}

const ort = await import("onnxruntime-web");
const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
const inputName = manifest.inputName ?? session.inputNames[0];
const outputName = manifest.outputName ?? session.outputNames[0];
console.log(`[stem:validate] model ${manifest.modelFile} · input "${inputName}" · output "${outputName}"`);

const planar = new Float32Array(samples * 2);
for (let i = 0; i < samples; i++) {
  planar[i] = chunk[i];
  planar[samples + i] = chunk[i];
}
const input = new ort.Tensor("float32", planar, [1, 2, samples]);
const started = Date.now();
const outputs = await session.run({ [inputName]: input });
const elapsed = Date.now() - started;
const output = outputs[outputName];
if (!output) {
  console.error(`[stem:validate] FAIL — output "${outputName}" missing. Outputs: ${session.outputNames.join(", ")}`);
  process.exit(1);
}
const data = output.data as Float32Array;
const dims = output.dims as number[];
console.log(
  `[stem:validate] output dims [${dims.join(", ")}] — ${(((samples / SR) * 1000) / Math.max(elapsed, 1)).toFixed(2)}× realtime (wasm)`,
);

const failures: string[] = [];
if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 8) {
  failures.push(`expected [1, 8, N] output (4 stems × stereo), got [${dims.join(", ")}]`);
}
if (dims[2] !== samples) failures.push(`output length ${dims[2]} != chunk ${samples}`);
const stemSamples = Math.floor(data.length / 8);
let nonSilent = 0;
for (let s = 0; s < 4; s++) {
  let energy = 0;
  for (let i = 0; i < stemSamples; i += 97) {
    const l = data[s * 2 * stemSamples + i];
    const r = data[(s * 2 + 1) * stemSamples + i];
    energy += l * l + r * r;
  }
  if (energy > 0) nonSilent += 1;
}
if (nonSilent < 2) failures.push(`only ${nonSilent}/4 stems non-silent — model produced (near-)silence`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`[stem:validate] FAIL: ${failure}`);
  process.exit(1);
}
console.log(`[stem:validate] PASS — ${nonSilent}/4 stems non-silent, contract holds.`);
if (pin) {
  manifest.gatePassed = true;
  manifest.inputName = inputName;
  manifest.outputName = outputName;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("[stem:validate] gatePassed PINNED — the model is now an actor (pf:stem-model on).");
} else {
  console.log("[stem:validate] dry run — re-run with --pin to activate.");
}
