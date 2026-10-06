/**
 * S5 — STEM MODEL BENCHMARK: WASM vs WebGPU realtime factor on a
 * deterministic synthetic fixture, printed as the support-matrix table
 * (ADR 0019 §S5). Requires the fetched checkpoint (`npm run stem:fetch`).
 *
 * Run: npm run stem:benchmark
 *
 * The realtime factor is model-chunk-seconds processed per wall second
 * (> 1 = faster than realtime). EP selection mirrors the client: WebGPU
 * when navigator.gpu yields an adapter, WASM otherwise — plus the
 * explicit cross-check so a WebGPU adapter that fails at session-create
 * shows up honestly in the table.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public", "models", "stem");
const manifestPath = path.join(OUT, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("[stem:benchmark] no manifest — run `npm run stem:fetch` first.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const modelPath = path.join(OUT, manifest.modelFile);
if (!existsSync(modelPath)) {
  console.error(`[stem:benchmark] model file missing: ${manifest.modelFile}`);
  process.exit(1);
}

// Node-side shim: navigator.gpu does not exist here, so WebGPU rows report
// "n/a (browser)" unless run through a GPU-enabled runtime.
const hasNavigatorGpu = typeof (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu === "object";

const SR = manifest.sampleRate ?? 44100;
const chunkSec = manifest.chunkSec ?? 7.8;
const samples = Math.floor(chunkSec * SR);
const fixture = new Float32Array(samples * 2);
for (let i = 0; i < samples; i++) {
  const t = i / SR;
  const value = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.02 * Math.sin(i * 12.9898);
  fixture[i] = value;
  fixture[samples + i] = value;
}

const ort = await import("onnxruntime-web");
const inputName = manifest.inputName ?? "input";
const outputName = manifest.outputName ?? "output";

async function benchEp(providers: string[], label: string): Promise<void> {
  let session;
  try {
    session = await ort.InferenceSession.create(modelPath, { executionProviders: providers });
  } catch (error) {
    console.log(`| ${label} | n/a | n/a | create failed: ${(error as Error).message.slice(0, 60)} |`);
    return;
  }
  const input = new ort.Tensor("float32", fixture, [1, 2, samples]);
  // Warm-up (shader compile / wasm warm caches) — not measured.
  await session.run({ [inputName]: input });
  const runs = 3;
  const started = Date.now();
  for (let i = 0; i < runs; i++) await session.run({ [inputName]: input });
  const perRunSec = (Date.now() - started) / runs / 1000;
  const realtime = chunkSec / perRunSec;
  console.log(`| ${label} | ${perRunSec.toFixed(2)} s | ${realtime.toFixed(2)}× | ${runs} runs, warm |`);
}

console.log(`[stem:benchmark] ${manifest.model} (${manifest.stemModelVersion}) — chunk ${chunkSec} s @ ${SR} Hz`);
console.log("| Execution provider | Chunk latency | Realtime factor | Notes |");
console.log("| ------------------ | ------------- | --------------- | ----- |");
await benchEp(["wasm"], "WASM SIMD");
if (hasNavigatorGpu) {
  await benchEp(["webgpu", "wasm"], "WebGPU");
} else {
  console.log("| WebGPU | n/a | n/a | no navigator.gpu in this runtime — run in a browser |");
}
console.log("[stem:benchmark] realtime factor > 1 = faster than realtime. Paste into ADR 0019 §S5.");
