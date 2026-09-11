/**
 * Cheap production preflight. This intentionally checks only deterministic,
 * local release invariants; it is not a substitute for the manual browser
 * matrix or a deployed health check.
 *
 * Usage (after `npm run build`):
 *   NODE_ENV=production CORS_ORIGIN=https://app.example.com npm run release:preflight
 *   KYX_GALLERY_PUBLIC=1 GALLERY_ADMIN_TOKEN=...  (when the public gallery is enabled)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const failures = [];

function fail(message) {
  failures.push(message);
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
// labels must never appear in shipped user-facing copy.
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
    if (/pulse\s+forge/i.test(text) || /\bpulseforge\b/i.test(text) || /\bvocalforge\b/i.test(text)) {
      fail(`legacy public brand label found in shipped artifact: ${path.replace(`${root}${path.sep}`, "")}`);
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
