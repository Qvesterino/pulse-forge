/**
 * Build the opt-in Windows MRT2 desktop package.
 *
 * The normal Windows package deliberately has no native inference runtime or
 * model data. This path requires a locally verified companion manifest and
 * adds only the fixed helper + manifest to Electron resources; model assets
 * stay in the user's fixed Documents/Magenta directory.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { verifyWindowsMrt2Manifest } = require("../desktop/mrt2-windows-assets.cjs");

const hostPath =
  process.env.KYX_MRT2_WINDOWS_HOST ?? path.join(root, "build", "mrt2-windows", "kyx-mrt2-windows-host.exe");
const hostScriptPath =
  process.env.KYX_MRT2_WINDOWS_HOST_SCRIPT ?? path.join(root, "companion", "mrt2-windows", "kyx_mrt2_windows_host.py");
const modelRoot = process.env.KYX_MRT2_WINDOWS_MODEL_ROOT;
const manifestPath =
  process.env.KYX_MRT2_WINDOWS_MANIFEST ?? path.join(root, "build", "mrt2-windows", "kyx-mrt2-windows-manifest.json");

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `code ${code}`})`));
    });
  });
}

function moveInto(from, toDir) {
  const target = path.join(toDir, path.basename(from));
  return rename(from, target).catch(async (error) => {
    if (error.code !== "EXDEV") throw error;
    await copyFile(from, target);
    await rm(from, { force: true });
  });
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Use a Windows x64 machine to build the MRT2-enabled desktop app.");
}
if (!modelRoot) {
  throw new Error("Set KYX_MRT2_WINDOWS_MODEL_ROOT to the fixed Windows MRT2 model root before packaging.");
}
if (path.basename(hostPath) !== "kyx-mrt2-windows-host.exe") {
  throw new Error("KYX_MRT2_WINDOWS_HOST must point to kyx-mrt2-windows-host.exe");
}

const verification = await verifyWindowsMrt2Manifest({ hostPath, hostScriptPath, modelRoot, manifestPath });
if (!verification.ok) {
  throw new Error(`MRT2 Windows package verification failed:\n${verification.errors.join("\n")}`);
}

const releaseDir = path.join(root, "release");
await mkdir(path.join(root, "build"), { recursive: true });
await copyFile(path.join(root, "public", "maskable-512x512.png"), path.join(root, "build", "icon.png"));
console.log("• verified MRT2 Windows helper/model manifest");
console.log("• web build (KYX_DESKTOP=1)…");
await run("npm", ["run", "build"], { KYX_DESKTOP: "1" });

const staging = await mkdtemp(path.join(os.tmpdir(), "kyx-mrt2-windows-"));
const configPath = path.join(root, "build", "electron-builder.mrt2-windows.tmp.json");
const config = {
  extends: path.join(root, "electron-builder.yml"),
  extraResources: [
    { from: hostPath, to: "mrt2-windows/kyx-mrt2-windows-host.exe" },
    { from: hostScriptPath, to: "mrt2-windows/kyx_mrt2_windows_host.py" },
    { from: manifestPath, to: "mrt2-windows/kyx-mrt2-windows-manifest.json" },
  ],
};

try {
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await mkdir(releaseDir, { recursive: true });
  await rm(path.join(releaseDir, "win-unpacked.tmp"), { recursive: true, force: true }).catch(() => {});
  await rm(path.join(releaseDir, "win-unpacked"), { recursive: true, force: true }).catch(() => {});
  console.log(`• electron-builder (win + MRT2 companion) → ${staging}`);
  await run("npx", ["electron-builder", "--win", "--config", configPath, "-c.directories.output=" + staging]);

  const skip = new Set(["builder-debug.yml", "builder-effective-config.yaml", "win-unpacked"]);
  for (const entry of await readdir(staging)) {
    if (skip.has(entry)) continue;
    await moveInto(path.join(staging, entry), releaseDir);
  }
  const setup = `KYX-Setup-${process.env.npm_package_version ?? "0.1.0"}.exe`;
  if (!existsSync(path.join(releaseDir, setup))) throw new Error(`expected ${setup} in release/`);
  console.log(`\nDone — ${setup} and the MRT2-enabled portable exe are in release/.`);
} finally {
  const resolvedStaging = path.resolve(staging);
  if (
    path.dirname(resolvedStaging) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolvedStaging).startsWith("kyx-mrt2-windows-")
  ) {
    throw new Error("Refusing to clean an unexpected MRT2 packaging staging path.");
  }
  await rm(resolvedStaging, { recursive: true, force: true });
  await rm(configPath, { force: true });
}
