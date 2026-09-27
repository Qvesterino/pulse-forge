#!/usr/bin/env node
/**
 * Fetch the Steinberg ASIO SDK headers for the native driver probe
 * (native/asio-host/asio-probe.cpp, ADR 0017).
 *
 *   node scripts/vendor-asio.mjs [--zip /path/to/asiosdk.zip]
 *
 * LICENSING GATE — read before running: the ASIO SDK is free to USE but its
 * license does NOT permit redistribution. The extracted headers therefore
 * live in native/asio-host/asio-sdk/ which is GITIGNORED; only this script
 * and the committed manifest (provenance + SHA-256) are in git. Everyone who
 * builds the probe fetches their own copy from Steinberg, exactly like every
 * other DAW. Running this script is an explicit acceptance of the Steinberg
 * ASIO SDK license terms.
 *
 * Headers only (asio.h / asiosys.h / iasiodrv.h): the probe talks to drivers
 * over raw COM (IASIO) and links no SDK translation units.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SDK_URL = "https://download.steinberg.net/sdk_downloads/asiosdk_2.3.3_2019-06-14.zip";
const SDK_ZIP_SHA256 = "bc425d9b98701af74b43639798566c48bc005af7328a2251cff722c1885076b2";
const SDK_ROOT = "asiosdk_2.3.3_2019-06-14";
const HEADERS = ["common/asio.h", "common/asiosys.h", "common/iasiodrv.h"];
const DEST = "native/asio-host/asio-sdk";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const zipArgIndex = process.argv.indexOf("--zip");
const zipPath = zipArgIndex >= 0 ? String(process.argv[zipArgIndex + 1]) : join(tmpdir(), "asiosdk.zip");
if (zipArgIndex >= 0 && !existsSync(zipPath)) {
  console.error(`[vendor-asio] --zip file not found: ${zipPath}`);
  process.exit(1);
}
if (!existsSync(zipPath)) {
  console.log(`[vendor-asio] downloading ${SDK_URL}`);
  console.log("[vendor-asio] NOTE: running this fetch accepts the Steinberg ASIO SDK license terms.");
  const res = await fetch(SDK_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
}

const zipHash = sha256File(zipPath);
if (zipHash !== SDK_ZIP_SHA256) {
  throw new Error(`zip hash mismatch: got ${zipHash}, expected ${SDK_ZIP_SHA256} (SDK changed? re-pin deliberately)`);
}

const extractRoot = join(tmpdir(), "asio-sdk-extract");
rmSync(extractRoot, { recursive: true, force: true });
mkdirSync(extractRoot, { recursive: true });
// Relative paths + cwd: GNU tar (Git Bash) treats `C:\...` as a remote host.
execFileSync("unzip", ["-o", "-q", zipPath, "-d", "asio-sdk-extract"], {
  cwd: tmpdir(),
  stdio: "ignore",
});

const sourceCommon = join(extractRoot, SDK_ROOT, "common");
for (const header of HEADERS) {
  if (!existsSync(join(sourceCommon, header.split("/")[1]))) {
    throw new Error(`upstream zip is missing ${header} — layout changed? re-pin deliberately`);
  }
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(join(DEST, "common"), { recursive: true });
const files = [];
for (const header of HEADERS) {
  const base = header.split("/")[1];
  execFileSync("cp", [join(sourceCommon, base), join(DEST, "common", base)]);
  files.push({ path: `common/${base}`, sha256: sha256File(join(DEST, "common", base)) });
}

const manifest = {
  source: SDK_URL,
  zipSha256: zipHash,
  license: "Steinberg ASIO SDK license — free to use, NOT redistributable; this directory is gitignored",
  vendoredAt: new Date().toISOString(),
  files,
};
writeFileSync("native/asio-host/asio-sdk-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[vendor-asio] vendored ${files.length} headers → ${DEST} (gitignored; manifest committed)`);
