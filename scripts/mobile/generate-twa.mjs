#!/usr/bin/env node
/**
 * Generate the TWA packaging inputs (ADR 0051):
 *  - android/twa-manifest.json       (Bubblewrap init input)
 *  - public/.well-known/assetlinks.json (Digital Asset Links verification)
 *
 * Both files are release artifacts: the manifest needs the real HTTPS origin
 * and the asset links need the SHA-256 of the signing certificate that will be
 * uploaded to Play. They are gitignored so a placeholder fingerprint can never
 * be deployed by accident.
 *
 * Usage:
 *   KYX_DEPLOY_URL=https://kyx.example \
 *   KYX_ANDROID_SHA256=AA:BB:... \
 *   npm run mobile:twa
 *
 * Optional: KYX_ANDROID_PACKAGE_ID (default app.kyx.studio),
 *           KYX_ANDROID_VERSION_NAME, KYX_ANDROID_VERSION_CODE.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssetLinks, buildTwaManifest } from "./twa-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const deployUrl = arg("origin") ?? process.env.KYX_DEPLOY_URL;
const sha256 = arg("sha256") ?? process.env.KYX_ANDROID_SHA256;
const packageId = arg("package") ?? process.env.KYX_ANDROID_PACKAGE_ID;
const versionName = process.env.KYX_ANDROID_VERSION_NAME;
const versionCode = process.env.KYX_ANDROID_VERSION_CODE;

if (!deployUrl || !sha256) {
  console.error(
    [
      "mobile:twa needs the deployed origin and the Android signing fingerprint.",
      "",
      "  KYX_DEPLOY_URL=https://your-origin.example \\",
      "  KYX_ANDROID_SHA256=AA:BB:... \\",
      "  npm run mobile:twa",
      "",
      "Optional: KYX_ANDROID_PACKAGE_ID, KYX_ANDROID_VERSION_NAME, KYX_ANDROID_VERSION_CODE.",
      "The output lives in android/twa-manifest.json and public/.well-known/assetlinks.json.",
    ].join("\n"),
  );
  process.exit(1);
}

try {
  const manifest = buildTwaManifest({
    deployUrl,
    ...(packageId ? { packageId } : {}),
    ...(versionName ? { versionName } : {}),
    ...(versionCode ? { versionCode } : {}),
  });
  const assetLinks = buildAssetLinks({ ...(packageId ? { packageId } : {}), sha256 });

  const manifestPath = resolve(root, "android", "twa-manifest.json");
  const linksPath = resolve(root, "public", ".well-known", "assetlinks.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(dirname(linksPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(linksPath, `${JSON.stringify(assetLinks, null, 2)}\n`, "utf8");

  console.log(`[mobile:twa] wrote ${manifestPath}`);
  console.log(`[mobile:twa] wrote ${linksPath}`);
  console.log("[mobile:twa] next: bubblewrap init --manifest android/twa-manifest.json");
} catch (error) {
  console.error(`[mobile:twa] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
