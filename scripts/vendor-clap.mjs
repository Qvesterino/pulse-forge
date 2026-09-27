/**
 * Vendor the CLAP SDK headers (https://github.com/free-audio/clap, MIT) into
 * native/clap-probe/clap/ for the out-of-process plugin probe (ADR 0016).
 *
 *   node scripts/vendor-clap.mjs [--tag 1.2.10] [--refetch]
 *
 * Downloads the pinned upstream release tarball, extracts the header tree and
 * the LICENSE, verifies reconciliation markers (version macros matching the
 * tag, key entry points present) and writes a SHA-256 manifest so tests can
 * prove the vendored tree is exactly what upstream shipped. Re-run with
 * --refetch to upgrade the pin; the tag lives in git history via the manifest.
 *
 * Unlike the ultina/ozvena/fxeq vendor scripts there is NO local divergence:
 * headers are used byte-exact, so every sync is a clean re-download.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = "https://github.com/free-audio/clap";
const DEFAULT_TAG = "1.2.10";
const DEST = "native/clap-probe/clap";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listHeaders(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHeaders(full));
    else if (entry.name.endsWith(".h")) out.push(full);
  }
  return out;
}

const tagIndex = process.argv.indexOf("--tag");
const TAG = tagIndex >= 0 ? String(process.argv[tagIndex + 1]) : DEFAULT_TAG;
const REFETCH = process.argv.includes("--refetch");

if (existsSync(DEST) && !REFETCH) {
  const manifestPath = join(DEST, "vendored-manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.log(`[vendor-clap] already vendored ${manifest.tag} — use --refetch to re-download`);
    process.exit(0);
  }
  console.error("[vendor-clap] header tree exists without a manifest — refusing to touch it; delete it first");
  process.exit(1);
}

const tarball = join(tmpdir(), `clap-${TAG}.tar.gz`);
if (REFETCH || !existsSync(tarball)) {
  const url = `${REPO}/archive/refs/tags/${TAG}.tar.gz`;
  console.log(`[vendor-clap] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
}

const extractRoot = join(tmpdir(), `clap-extract-${TAG}`);
rmSync(extractRoot, { recursive: true, force: true });
mkdirSync(extractRoot, { recursive: true });
// Relative paths + cwd: GNU tar (Git Bash) treats `C:\...` as a remote host
// spec, and System32 bsdtar disagrees on --force-local. Basenames sidestep both.
execFileSync("tar", ["-xzf", `clap-${TAG}.tar.gz`, "-C", `clap-extract-${TAG}`], {
  cwd: tmpdir(),
  stdio: "inherit",
});

const sourceTree = join(extractRoot, `clap-${TAG}`);
const sourceInclude = join(sourceTree, "include", "clap");
if (!existsSync(sourceInclude)) throw new Error("upstream tarball is missing include/clap — layout changed?");

// Reconciliation markers — the sync refuses to proceed if the upstream
// snapshot is missing anything the probe compiles against.
const versionHeader = readFileSync(join(sourceInclude, "version.h"), "utf8");
const major = /#define CLAP_VERSION_MAJOR (\d+)/.exec(versionHeader)?.[1];
const minor = /#define CLAP_VERSION_MINOR (\d+)/.exec(versionHeader)?.[1];
const revision = /#define CLAP_VERSION_REVISION (\d+)/.exec(versionHeader)?.[1];
if (!major || !minor || !revision) throw new Error("version.h lacks CLAP_VERSION_* macros");
const expected = TAG.split(".").map((part) => Number(part));
if (Number(major) !== expected[0] || Number(minor) !== expected[1] || Number(revision) !== expected[2]) {
  throw new Error(`tag ${TAG} but headers say ${major}.${minor}.${revision} — pin mismatch`);
}
for (const marker of ["clap.h", "entry.h", "plugin.h", "factory/plugin-factory.h", "private/macros.h"]) {
  if (!existsSync(join(sourceInclude, marker))) throw new Error(`missing reconciliation marker: ${marker}`);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
execFileSync("cp", ["-r", `${sourceInclude}/.`, DEST]);
const licenseDest = join(DEST, "..", "CLAP-LICENSE");
execFileSync("cp", [join(sourceTree, "LICENSE"), licenseDest]);

const files = listHeaders(DEST).map((path) => ({ path: path.replaceAll("\\", "/").slice(DEST.length + 1), sha256: sha256File(path) }));
const manifest = {
  source: REPO,
  tag: TAG,
  license: "MIT",
  vendoredAt: new Date().toISOString(),
  fileCount: files.length,
  files,
};
writeFileSync(join(DEST, "vendored-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[vendor-clap] vendored ${files.length} headers from ${TAG} → ${DEST} (+ ../CLAP-LICENSE)`);
