/**
 * Build and package the opt-in MRT2 Small macOS/Apple Silicon desktop app.
 * This is intentionally separate from the existing Windows desktop release.
 */
import { access, cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");
const stagingParent = path.join(os.tmpdir(), "kyx-mrt2-mac-");

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + " " + args.join(" ") + " failed (" + (signal ?? "code " + code) + ")"));
    });
  });
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Use a macOS Apple Silicon machine to build the MRT2-enabled desktop app.");
}

await run(process.execPath, [path.join(root, "scripts", "build-mrt2-native-host.mjs")]);
console.log("• web build (KYX_DESKTOP=1)…");
await run("npm", ["run", "build"], { KYX_DESKTOP: "1" });

await mkdir(releaseDir, { recursive: true });
const staging = await mkdtemp(stagingParent);
try {
  console.log("• electron-builder (mac arm64) → " + staging);
  await run("npx", ["electron-builder", "--mac", "dmg", "zip", "--arm64", "-c.directories.output=" + staging]);

  const artifacts = (await readdir(staging)).filter(
    (entry) => entry !== "builder-debug.yml" && entry !== "builder-effective-config.yaml",
  );
  if (!artifacts.some((entry) => entry.endsWith(".dmg")) || !artifacts.some((entry) => entry.endsWith(".zip"))) {
    throw new Error("electron-builder did not produce both expected MRT2 macOS artifacts (DMG and ZIP).");
  }
  for (const entry of artifacts) {
    try {
      await access(path.join(releaseDir, entry));
      throw new Error("Refusing to overwrite existing release artifact: " + path.join(releaseDir, entry));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  for (const entry of artifacts) {
    const source = path.join(staging, entry);
    const destination = path.join(releaseDir, entry);
    try {
      await rename(source, destination);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      await cp(source, destination, { recursive: true });
      await rm(source, { recursive: true, force: true });
    }
  }
} finally {
  const resolvedStaging = path.resolve(staging);
  if (
    path.dirname(resolvedStaging) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolvedStaging).startsWith(path.basename(stagingParent))
  ) {
    throw new Error("Refusing to clean an unexpected MRT2 packaging staging path.");
  }
  await rm(resolvedStaging, { recursive: true, force: true });
}

console.log("Mac packaging finished. Inspect release/ for the DMG and ZIP artifacts.");
