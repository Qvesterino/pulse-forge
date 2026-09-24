/**
 * Verify the unsigned MRT2 macOS QA package produced by
 * `desktop:build:mac:mrt2`. Checks both artifacts, unpacks the ZIP, inspects
 * the arm64 app/helper, then boots the packaged Electron app in smoke mode.
 * No MRT2 model files or model inference are required for this packaging test.
 */
import { access, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(root, "release");
const tempPrefix = "kyx-mrt2-package-verify-";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? `code ${result.status}`})`);
  }
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

async function onlyArtifact(extension) {
  const matches = (await readdir(releaseDir)).filter((entry) => entry.toLowerCase().endsWith(extension));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${extension} in release/, found ${matches.length}.`);
  }
  const artifactPath = path.join(releaseDir, matches[0]);
  const artifactStat = await lstat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0)
    throw new Error(`${matches[0]} is not a non-empty regular file.`);
  return artifactPath;
}

function assertArm64(binaryPath, label) {
  const architectures = output("lipo", ["-archs", binaryPath]).split(/\s+/u);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`${label} must contain only arm64; found: ${architectures.join(", ") || "none"}.`);
  }
}

async function assertExecutable(filePath, label) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} is missing or is not a regular file.`);
  await access(filePath, constants.X_OK);
}

async function smokePackagedApp(executablePath, appPath, smokeHome) {
  await mkdir(smokeHome, { recursive: true });
  console.log("• boot packaged KYX app in smoke mode…");
  await new Promise((resolve, reject) => {
    const child = spawn(executablePath, [], {
      cwd: appPath,
      env: { ...process.env, HOME: smokeHome, KYX_SMOKE: "1" },
      stdio: "inherit",
    });
    let settled = false;
    let timedOut = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (timedOut) finish(new Error("Packaged KYX smoke test exceeded 60 seconds."));
      else if (code === 0) finish();
      else finish(new Error(`Packaged KYX smoke test failed (${signal ?? `code ${code}`}).`));
    });
  });
}

async function smokeNativeHost(nativeHostPath, appPath, modelRoot) {
  await mkdir(modelRoot, { recursive: true });
  console.log("• launch packaged MRT2 helper without model weights…");
  await new Promise((resolve, reject) => {
    const child = spawn(nativeHostPath, ["--model-root", modelRoot], {
      cwd: appPath,
      env: { ...process.env, HOME: path.dirname(modelRoot) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 16_384) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16_384) child.kill("SIGKILL");
    });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error("Packaged MRT2 helper did not complete its no-model startup check within 15 seconds."));
      } else if (code === 2 && stdout.length === 0 && stderr.includes("MusicCoCa resources were not found")) finish();
      else finish(new Error(`Packaged MRT2 helper no-model check failed (${signal ?? `code ${code}`}).`));
    });
  });
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The macOS package verifier must run on Apple Silicon macOS.");
}

const dmgPath = await onlyArtifact(".dmg");
const zipPath = await onlyArtifact(".zip");
console.log("• verify DMG filesystem image…");
run("hdiutil", ["verify", dmgPath]);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
try {
  const unpackDir = path.join(tempRoot, "zip");
  await mkdir(unpackDir);
  console.log("• extract app from ZIP artifact…");
  run("ditto", ["-x", "-k", zipPath, unpackDir]);

  const appBundles = (await readdir(unpackDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(".app"),
  );
  if (appBundles.length !== 1) throw new Error(`Expected one top-level .app in the ZIP, found ${appBundles.length}.`);

  const appPath = path.join(unpackDir, appBundles[0].name);
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const executableName = output("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlist]);
  const bundleIdentifier = output("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist]);
  if (bundleIdentifier !== "app.kyx.studio") throw new Error(`Unexpected app bundle identifier: ${bundleIdentifier}.`);
  if (!/^[A-Za-z0-9._-]+$/u.test(executableName)) throw new Error("App bundle has an invalid executable name.");

  const appExecutable = path.join(appPath, "Contents", "MacOS", executableName);
  const nativeHost = path.join(appPath, "Contents", "Resources", "mrt2-host", "kyx-mrt2-host");
  await assertExecutable(appExecutable, "KYX app executable");
  await assertExecutable(nativeHost, "MRT2 native host");
  assertArm64(appExecutable, "KYX app executable");
  assertArm64(nativeHost, "MRT2 native host");

  const smokeHome = path.join(tempRoot, "home");
  await smokeNativeHost(nativeHost, appPath, path.join(smokeHome, "empty-model-root"));
  await smokePackagedApp(appExecutable, appPath, smokeHome);
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  if (path.dirname(resolvedTemp) !== path.resolve(os.tmpdir()) || !path.basename(resolvedTemp).startsWith(tempPrefix)) {
    throw new Error("Refusing to remove an unexpected macOS package verification temp path.");
  }
  await rm(resolvedTemp, { recursive: true, force: true });
}

console.log(
  "macOS MRT2 package verification passed: DMG valid; ZIP contains an arm64 KYX app and executable arm64 MRT2 host; helper loaded and reported missing optional model assets cleanly; packaged app booted successfully.",
);
