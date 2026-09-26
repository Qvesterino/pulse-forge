/**
 * Copies the onnxruntime-web WASM runtime files from node_modules into
 * public/models/ort/ so the ranker worker can load ORT fully offline
 * (goal doc Fáze 3 — no CDN, no network). Run after installing/upgrading
 * onnxruntime-web: npm run ranker:ort-sync
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(ROOT, "node_modules", "onnxruntime-web", "dist");
const dest = path.join(ROOT, "public", "models", "ort");

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const file of readdirSync(src)) {
  // ORT diet (Phase 5 pack wave): only the plain simd-threaded variant is
  // fetched at runtime (ranker/prior workers use ort-wasm-simd-threaded.wasm
  // + the matching .mjs). The asyncify/jsep/jspi variants (~69.5 MB) are
  // gitignored — copying them would resurrect dead deploy weight.
  if (/^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(file)) {
    copyFileSync(path.join(src, file), path.join(dest, file));
    copied += 1;
  }
}
console.log(`[ort-sync] ${copied} file(s) → public/models/ort/`);
