/**
 * Downloads the htdemucs ONNX stem-separation checkpoint (ADR 0019 Tier 2)
 * into public/models/stem/ with a sha256-pinned manifest — never committed
 * to git; the app serves it from its own origin (offline-first after the
 * one-time fetch).
 *
 * Source: StemSplitio/htdemucs-ft-onnx on Hugging Face (MIT, see ADR 0019
 * licensing note). The FT variant ships four specialist sub-models; the
 * DEFAULT here fetches the single non-FT htdemucs export (adowu) — one
 * ~80 MB file, one session. Override with STEM_MODEL_URL / STEM_MODEL_FILE.
 *
 * Run: npm run stem:fetch
 * The manifest is written WITHOUT gatePassed — S4's validation pass pins it
 * (the audio-tag ritual: a candidate is not an actor).
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SOURCES = {
  htdemucs: {
    url: process.env.STEM_MODEL_URL ?? "https://huggingface.co/adowu/htdemucs-onnx/resolve/main/htdemucs.onnx",
    file: "htdemucs.onnx",
  },
  htdemucs_ft: {
    url:
      process.env.STEM_MODEL_URL ?? "https://huggingface.co/StemSplitio/htdemucs-ft-onnx/resolve/main/htdemucs_ft.onnx",
    file: "htdemucs_ft.onnx",
  },
};

const variant = process.env.STEM_MODEL_VARIANT ?? "htdemucs";
const source = SOURCES[variant];
if (!source) {
  console.error(`[stem:fetch] unknown variant "${variant}" — use one of: ${Object.keys(SOURCES).join(", ")}`);
  process.exit(1);
}

const OUT = path.join(process.cwd(), "public", "models", "stem");
mkdirSync(OUT, { recursive: true });

console.log(`[stem:fetch] fetching ${variant} → ${source.url}`);
const response = await fetch(source.url);
if (!response.ok) {
  console.error(`[stem:fetch] HTTP ${response.status} — check STEM_MODEL_URL or the HF repo layout.`);
  process.exit(1);
}
const buffer = Buffer.from(await response.arrayBuffer());
const hash = createHash("sha256").update(buffer).digest("hex");
writeFileSync(path.join(OUT, source.file), buffer);
console.log(`[stem:fetch] done (${(buffer.length / 1024 / 1024).toFixed(1)} MB) sha256 ${hash.slice(0, 16)}…`);

const manifest = {
  stemModelVersion: `stem-${variant}.v1`,
  model: "htdemucs",
  modelHash: hash,
  modelFile: source.file,
  sampleRate: 44100,
  chunkSec: 7.8,
  stems: ["vocals", "drums", "bass", "other"],
  gatePassed: false,
};
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[stem:fetch] OK → ${OUT} (gatePassed: false — S4 validation pins it)`);
