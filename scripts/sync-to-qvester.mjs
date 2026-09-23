/**
 * KYX → Qvester Studio sync bridge.
 *
 * Builds the app for the ecosystem mount (STUDIO_APP_BASE=/pulse-forge/)
 * and copies the artifact into the Qvester Studio repo, which vendors the
 * BUILT dist (apps/KYX/dist) — the landing repo's CI never sees this repo.
 * Re-run before every KYX release you want the ecosystem to serve:
 *
 *   npm run ecosystem:sync
 *
 * Target resolution: QVESTER_TARGET env, else the sibling checkout
 * D:\QVESTER_LANDING_PAGE. The script is idempotent and leaves the target
 * repo's git state alone (staging/committing is the caller's decision).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MOUNT = "/pulse-forge/";
const here = fileURLToPath(new URL("..", import.meta.url));
const target =
  process.env.QVESTER_TARGET !== undefined
    ? resolve(process.env.QVESTER_TARGET)
    : resolve(here, "..", "QVESTER_LANDING_PAGE");
const targetDist = join(target, "apps", "KYX", "dist");

function fail(message) {
  console.error(`[ecosystem:sync] FAIL — ${message}`);
  process.exit(1);
}

// 1. The target repo must exist — never create ecosystem directories on a
// typo'd path.
if (!existsSync(join(target, "package.json"))) {
  fail(`Qvester Studio repo not found at ${target} (set QVESTER_TARGET)`);
}

// 2. Build with the mount base. spawnSync passes env verbatim (no shell
// path mangling), so "/pulse-forge/" survives Windows Git Bash hosts.
console.log(`[ecosystem:sync] building with base ${MOUNT} …`);
const build = spawnSync("npx", ["vite", "build"], {
  cwd: here,
  shell: process.platform === "win32",
  stdio: "inherit",
  env: { ...process.env, STUDIO_APP_BASE: MOUNT },
});
if (build.status !== 0) fail("vite build failed");

// 3. Validate the artifact BEFORE touching the target.
const indexPath = join(here, "dist", "index.html");
if (!existsSync(indexPath)) fail("dist/index.html missing after build");
const index = readFileSync(indexPath, "utf8");
if (!index.includes(MOUNT)) fail(`dist/index.html carries no ${MOUNT} asset refs — base did not apply`);

// 4. Swap the vendored dist in the target repo.
if (existsSync(targetDist)) rmSync(targetDist, { recursive: true, force: true });
mkdirSync(targetDist, { recursive: true });
cpSync(join(here, "dist"), targetDist, { recursive: true });
// The studio artifact validator requires a 404.html SPA fallback next to
// index.html (same content — the app routes from history.state).
copyFileSync(indexPath, join(targetDist, "404.html"));

// 5. Provenance: which KYX commit produced this artifact.
let commit = "unknown";
try {
  commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, shell: process.platform === "win32" })
    .stdout.toString()
    .trim();
} catch {
  /* detached/no-git — provenance stays "unknown" */
}
writeFileSync(
  join(targetDist, "PROVENANCE.json"),
  `${JSON.stringify({ app: "kyx", source: "pulse-forge", commit, syncedAt: new Date().toISOString(), mount: MOUNT }, null, 2)}\n`,
);

// 6. Post-copy sanity: the mounted entry + the sw must be there.
for (const required of ["index.html", "sw.js", "manifest.webmanifest"]) {
  if (!existsSync(join(targetDist, required))) fail(`target dist missing ${required}`);
}
console.log(`[ecosystem:sync] OK — KYX dist (commit ${commit}) synced to ${targetDist}. Review + commit in the Qvester repo.`);
