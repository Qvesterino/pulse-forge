/**
 * ONNX model pack registry (ROADMAP-FULL-DAW Phase 5: "Download larger ONNX
 * model packs only on explicit request with size, license, hash, progress,
 * cancellation, cache and offline fallback").
 *
 * A pack is an optional, explicitly downloaded model bundle. Small models
 * (intent ranker ~25 KB, symbolic priors ~20 KB) ship with the app and are
 * NOT packs. The semantic embedding pack (~118 MB q8) is dev-time-only on
 * disk (`npm run semantic:fetch` populates a gitignored public/ folder), so
 * a deployed KYX serves 404s for it — the pack manager downloads it from
 * the pinned upstream CDN release, verifies every downloaded file against
 * the SHA-256 set below (mirrored from public/models/semantic/manifest.json
 * — the test suite pins the two together) and stores it in the Cache API.
 *
 * Layout mirrors the repository-shaped path the transformers.js loader
 * requests: {baseDir}/{modelId}/{file}, plus our own manifest.json at
 * {baseDir}/manifest.json (inlined here because a deployment has no copy).
 */

export interface ModelPackFile {
  /** Path relative to the pack's local base directory (modelId-prefixed). */
  path: string;
  /** Absolute upstream URL the file is downloaded from when missing. */
  sourceUrl: string;
  /** SHA-256 (hex) of the expected bytes — verified before caching. */
  sha256: string;
}

export interface ModelPack {
  id: string;
  label: string;
  /** One-line user-facing purpose. */
  purpose: string;
  license: string;
  licenseUrl: string;
  /** Local base directory the runtime loads the pack from (no trailing slash). */
  baseDir: string;
  /** Approximate total size in MB for the download prompt (display only). */
  approxSizeMb: number;
  /** Files downloaded from the upstream pinned release. */
  files: ModelPackFile[];
  /** Exact manifest.json content cached at {baseDir}/manifest.json (ours, not downloadable). */
  manifestContent: string;
  /** What stays functional WITHOUT the pack (the honest fallback). */
  fallbackNote: string;
}

const SEMANTIC_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const SEMANTIC_UPSTREAM = `https://huggingface.co/${SEMANTIC_MODEL_ID}/resolve/main`;

/** Manifest content — byte-identical to scripts/fetch-semantic-model.mjs output. */
const SEMANTIC_MANIFEST = JSON.stringify(
  {
    semanticVersion: "semantic-embed.v1",
    modelId: SEMANTIC_MODEL_ID,
    dtype: "q8",
    files: {
      "onnx/model_quantized.onnx": "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
      "tokenizer.json": "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
      "tokenizer_config.json": "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2",
      "config.json": "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7",
    },
  },
  null,
  2,
);

/**
 * File hashes mirror public/models/semantic/manifest.json (the dev-time
 * fetch script's source of truth). tests/model-packs.test.ts fails if the
 * two drift apart.
 */
export const SEMANTIC_PACK: ModelPack = {
  id: "semantic-embed",
  label: "Semantic embedding model",
  purpose: "Understands style and mood wording in INTENT prompts in 50+ languages (better candidate ranking).",
  license: "Apache-2.0 — Xenova/paraphrase-multilingual-MiniLM-L12-v2 (q8 quantized)",
  licenseUrl: `https://huggingface.co/${SEMANTIC_MODEL_ID}`,
  baseDir: "/models/semantic",
  approxSizeMb: 118,
  files: [
    {
      path: `${SEMANTIC_MODEL_ID}/onnx/model_quantized.onnx`,
      sourceUrl: `${SEMANTIC_UPSTREAM}/onnx/model_quantized.onnx`,
      sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
    },
    {
      path: `${SEMANTIC_MODEL_ID}/tokenizer.json`,
      sourceUrl: `${SEMANTIC_UPSTREAM}/tokenizer.json`,
      sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
    },
    {
      path: `${SEMANTIC_MODEL_ID}/tokenizer_config.json`,
      sourceUrl: `${SEMANTIC_UPSTREAM}/tokenizer_config.json`,
      sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2",
    },
    {
      path: `${SEMANTIC_MODEL_ID}/config.json`,
      sourceUrl: `${SEMANTIC_UPSTREAM}/config.json`,
      sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7",
    },
  ],
  manifestContent: `${SEMANTIC_MANIFEST}\n`,
  fallbackNote:
    "Without the pack, INTENT generation still works fully — candidates are ranked by the local heuristic chain (no download, works offline).",
};

export const MODEL_PACKS: readonly ModelPack[] = [SEMANTIC_PACK];

export function modelPackById(id: string): ModelPack | undefined {
  return MODEL_PACKS.find((pack) => pack.id === id);
}

/** Fixed manifest filename inside every pack's baseDir (inline content, not downloaded). */
export const PACK_MANIFEST_PATH = "manifest.json";
