/**
 * Cheap production preflight. This intentionally checks only deterministic,
 * local release invariants; it is not a substitute for the manual browser
 * matrix or a deployed health check.
 *
 * Usage (after `npm run build`):
 *   NODE_ENV=production CORS_ORIGIN=https://app.example.com npm run release:preflight
 *   KYX_GALLERY_PUBLIC=1 GALLERY_ADMIN_TOKEN=...  (when the public gallery is enabled)
 *
 * The runner is `vite-node` (see package.json): the semantic pack contract is
 * read from src/ai/packs/registry.ts, so the gate compares against the ONE
 * owner of those hashes instead of a second, drifting copy.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SEMANTIC_PACK } from "../src/ai/packs/registry.ts";
import { findLegacyPublicBrandLabel } from "./release-brand-rule.mjs";

const root = process.cwd();
const dist = join(root, "dist");
const failures = [];

function fail(message) {
  failures.push(message);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

if (process.env.NODE_ENV !== "production") {
  fail("NODE_ENV must be exactly production");
}

const corsOrigins = String(process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (corsOrigins.length === 0) {
  fail("CORS_ORIGIN must contain at least one explicit origin");
} else {
  for (const origin of corsOrigins) {
    if (origin === "*") {
      fail("CORS_ORIGIN must not contain wildcard * in production");
      continue;
    }
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        fail(`CORS_ORIGIN has an unsupported protocol: ${origin}`);
      }
      if (!parsed.hostname) fail(`CORS_ORIGIN is missing a hostname: ${origin}`);
    } catch {
      fail(`CORS_ORIGIN contains an invalid origin: ${origin}`);
    }
  }
}

const galleryPublic = /^(1|true|yes)$/i.test(String(process.env.KYX_GALLERY_PUBLIC ?? ""));
if (galleryPublic && String(process.env.GALLERY_ADMIN_TOKEN ?? "").length < 16) {
  fail("KYX_GALLERY_PUBLIC is enabled but GALLERY_ADMIN_TOKEN is missing or shorter than 16 characters");
}

const requiredFiles = [
  "index.html",
  "manifest.webmanifest",
  "bitcrusher-worklet.js",
  "core-worklet.js",
  "fxeq-worklet.js",
  "ultina-worklet.js",
  "ozvena-worklet.js",
  "models/intent-ranker-v1.onnx",
  "models/intent-ranker-v1.manifest.json",
];
for (const relative of requiredFiles) {
  const path = join(dist, relative);
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) fail(`missing or empty production artifact: dist/${relative}`);
  } catch {
    fail(`missing or unreadable production artifact: dist/${relative}`);
  }
}

const rankerManifestPath = join(dist, "models", "intent-ranker-v1.manifest.json");
const rankerModelPath = join(dist, "models", "intent-ranker-v1.onnx");
if (existsSync(rankerManifestPath) && existsSync(rankerModelPath)) {
  try {
    const rankerManifest = JSON.parse(readFileSync(rankerManifestPath, "utf8"));
    const actualHash = createHash("sha256").update(readFileSync(rankerModelPath)).digest("hex");
    if (rankerManifest.modelPath !== "/models/intent-ranker-v1.onnx") {
      fail("dist ranker manifest points outside the shipped local model path");
    }
    if (actualHash !== String(rankerManifest.modelHash ?? "").toLowerCase()) {
      fail("dist ranker model hash does not match its manifest");
    }
  } catch {
    fail("dist ranker manifest is not valid JSON or its model is unreadable");
  }
}

// The semantic embedding model is NOT shipped in dist. A deployment serves
// 404 for /models/semantic/, and the pack manager downloads the model from
// the pinned upstream release, verifying every file against the SHA-256 set
// in src/ai/packs/registry.ts. The dev-time fetch artifact
// (public/models/semantic/, gitignored) only exists in a local build that ran
// `npm run semantic:fetch`.
//
// So the release invariant is the PACK CONTRACT — the registry that ships with
// the app — and not the presence of a dev-time artifact. Requiring the
// artifact made this gate unsatisfiable on every clean checkout, including
// every CI runner: it asked for a file the deployed architecture deliberately
// does not ship. When a build DOES carry the model, its bytes must match the
// pinned hashes exactly.
const semanticModelId = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const semanticFiles = ["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json", "config.json"];

// 1. THE PACK CONTRACT — the part that ships, so it is checked on every run.
let packManifest;
if (!SEMANTIC_PACK || SEMANTIC_PACK.id !== "semantic-embed") {
  fail("the semantic model pack is not registered — the runtime could not obtain the model");
} else {
  try {
    packManifest = JSON.parse(SEMANTIC_PACK.manifestContent);
  } catch {
    fail("the semantic pack manifest content is not valid JSON");
  }
  if (packManifest && typeof packManifest === "object" && !Array.isArray(packManifest)) {
    if (packManifest.semanticVersion !== "semantic-embed.v1") {
      fail("the semantic pack manifest has an unsupported semanticVersion");
    }
    if (packManifest.modelId !== semanticModelId) {
      fail("the semantic pack manifest must pin the multilingual MiniLM model");
    }
    if (packManifest.dtype !== "q8") {
      fail("the semantic pack manifest must use the q8 format");
    }
    for (const relative of semanticFiles) {
      const pinnedHash = String(packManifest.files?.[relative] ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(pinnedHash)) {
        fail(`the semantic pack manifest has no valid SHA-256 for ${relative}`);
        continue;
      }
      const entry = SEMANTIC_PACK.files.find((file) => file.path === `${semanticModelId}/${relative}`);
      if (!entry) {
        fail(`the semantic pack has no download entry for ${relative}`);
        continue;
      }
      if (String(entry.sha256).toLowerCase() !== pinnedHash) {
        fail(`the semantic pack's download hash differs from its manifest for ${relative}`);
      }
      if (!/^https:\/\/huggingface\.co\/Xenova\//.test(entry.sourceUrl)) {
        fail(`the semantic pack's source URL is not a pinned upstream URL for ${relative}`);
      }
    }
  } else {
    fail("the semantic pack manifest content must be a JSON object");
  }
}

// 2. THE SHIPPED MODEL — only when this build carries one.
const semanticManifestPath = join(dist, "models", "semantic", "manifest.json");
let semanticManifest;
if (existsSync(semanticManifestPath)) {
  try {
    semanticManifest = JSON.parse(readFileSync(semanticManifestPath, "utf8"));
  } catch {
    fail("the shipped dist semantic model manifest is not valid JSON");
  }
  if (semanticManifest && typeof semanticManifest === "object" && !Array.isArray(semanticManifest)) {
    if (semanticManifest.semanticVersion !== "semantic-embed.v1") {
      fail("dist semantic manifest has an unsupported semanticVersion");
    }
    if (semanticManifest.modelId !== semanticModelId || semanticManifest.dtype !== "q8") {
      fail("dist semantic manifest must use the multilingual MiniLM model in q8 format");
    }

    for (const relative of semanticFiles) {
      const path = join(dist, "models", "semantic", semanticModelId, relative);
      try {
        const info = statSync(path);
        if (!info.isFile() || info.size === 0) {
          fail(`missing or empty production semantic asset: dist/models/semantic/${semanticModelId}/${relative}`);
          continue;
        }
      } catch {
        fail(`missing or unreadable production semantic asset: dist/models/semantic/${semanticModelId}/${relative}`);
        continue;
      }

      const expectedHash = String(semanticManifest.files?.[relative] ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        fail(`semantic manifest has no valid SHA-256 for ${relative}`);
        continue;
      }
      try {
        const actualHash = await sha256File(path);
        if (actualHash !== expectedHash) fail(`dist semantic asset hash does not match manifest: ${relative}`);
        // The bytes must match the PINNED hash too: a local model that drifted
        // from the pinned upstream release is a release defect even when its
        // own manifest agrees with it.
        const pinned = SEMANTIC_PACK.files.find((file) => file.path === `${semanticModelId}/${relative}`)?.sha256;
        if (pinned && actualHash !== String(pinned).toLowerCase()) {
          fail(`dist semantic asset does not match the pinned pack hash: ${relative}`);
        }
      } catch {
        fail(`could not hash production semantic asset: ${relative}`);
      }
    }
  } else if (semanticManifest !== undefined) {
    fail("dist semantic manifest must be a JSON object");
  }
} else {
  console.log(
    "[release-preflight] semantic model is not shipped in dist — the pack manager fetches it from the pinned upstream at runtime",
  );
}

const manifestPath = join(dist, "manifest.webmanifest");
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== "KYX — Browser DAW" || manifest.short_name !== "KYX") {
      fail("dist/manifest.webmanifest does not carry the public KYX identity");
    }
  } catch {
    fail("dist/manifest.webmanifest is not valid JSON");
  }
}

const assetsDir = join(dist, "assets");
if (!existsSync(assetsDir)) {
  fail("missing production asset directory: dist/assets");
} else {
  try {
    if (!statSync(assetsDir).isDirectory() || !readdirSync(assetsDir).some((file) => file.endsWith(".js"))) {
      fail("dist/assets contains no JavaScript application chunk");
    }
  } catch {
    fail("dist/assets is not a readable directory");
  }
}

// Compatibility parsing lives in source/import code, but old product/family
// labels must never appear in shipped user-facing copy. The rule itself
// (and the line between a label and an identifier) lives in
// scripts/release-brand-rule.mjs, shared with tests/release-brand-rule.test.ts.
const shippedTextFiles = [
  join(dist, "index.html"),
  join(dist, "manifest.webmanifest"),
  ...(existsSync(assetsDir)
    ? readdirSync(assetsDir)
        .filter((file) => /\.(js|css)$/.test(file))
        .map((file) => join(assetsDir, file))
    : []),
];
for (const path of shippedTextFiles) {
  try {
    const text = readFileSync(path, "utf8");
    const legacy = findLegacyPublicBrandLabel(text);
    if (legacy) {
      fail(
        `legacy public brand label found in shipped artifact: ${path.replace(`${root}${path.sep}`, "")} (${legacy})`,
      );
    }
  } catch {
    fail(`could not scan shipped artifact for legacy branding: ${path}`);
  }
}

if (failures.length > 0) {
  console.error("[release-preflight] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[release-preflight] PASS — production config, KYX artifacts and shipped branding scan are clean");
