/**
 * KYX desktop release build:
 *   1. copy the PWA maskable icon into electron-builder's buildResources,
 *   2. run the normal web build with KYX_DESKTOP=1 (skips the PWA/service
 *      worker layer — the desktop shell doesn't need a precache),
 *   3. package with electron-builder for Windows (NSIS + portable, per
 *      electron-builder.yml).
 *
 * Packaging extracts the Electron runtime into `<output>/win-unpacked.tmp`
 * and immediately renames it — a window in which file watchers/indexers
 * running on this workspace (e.g. Codex, antivirus real-time scans) can
 * hold a handle on a freshly written file and the rename fails with EPERM.
 * To stay out of that race, packaging happens in a fresh directory under
 * the OS temp dir and the artifacts are moved back into `release/`.
 *
 * Output lands in `release/`: KYX-Setup-<version>.exe and KYX-Portable-<version>.exe.
 */
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      // npm/npx are .cmd shims on Windows — shell is required to spawn them.
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (code ${code})`));
    });
    child.on("error", reject);
  });
}

/** Move across devices (temp and the repo may live on different volumes). */
async function moveInto(from, toDir) {
  const target = path.join(toDir, path.basename(from));
  try {
    await rename(from, target);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await cp(from, target, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

await mkdir(path.join(root, "build"), { recursive: true });
await copyFile(
  path.join(root, "public", "maskable-512x512.png"),
  path.join(root, "build", "icon.png"),
);
console.log("• icon → build/icon.png");

console.log("• web build (KYX_DESKTOP=1)…");
await run("npm", ["run", "build"], { KYX_DESKTOP: "1" });

const releaseDir = path.join(root, "release");
await mkdir(releaseDir, { recursive: true });
// A leftover win-unpacked.tmp from an interrupted run is junk (or locked);
// ignore failures — electron-builder stages in a fresh temp dir anyway.
await rm(path.join(releaseDir, "win-unpacked.tmp"), { recursive: true, force: true }).catch(() => {});
await rm(path.join(releaseDir, "win-unpacked"), { recursive: true, force: true }).catch(() => {});

const staging = path.join(os.tmpdir(), `kyx-desktop-release-${Date.now()}`);
console.log(`• electron-builder (win) → ${staging}`);
await run("npx", ["electron-builder", "--win", "-c.directories.output=" + staging]);

const skip = new Set([
  "builder-debug.yml",
  "builder-effective-config.yaml",
  // The unpacked app is a packaging byproduct, not a distribution artifact —
  // and copying it into the workspace invites file-watcher locks on freshly
  // written files (see the EPERM note above). Run it from the staging dir if
  // needed; it's removed with the staging dir after the move.
  "win-unpacked",
]);
for (const entry of await readdir(staging)) {
  if (skip.has(entry)) continue;
  await moveInto(path.join(staging, entry), releaseDir);
}
await rm(staging, { recursive: true, force: true }).catch(() => {});

const setup = `KYX-Setup-${process.env.npm_package_version ?? "0.1.0"}.exe`;
if (!existsSync(path.join(releaseDir, setup))) {
  throw new Error(`expected ${setup} in release/ — packaging output missing`);
}
console.log(`\nDone — ${setup} and the portable exe are in release/.`);
