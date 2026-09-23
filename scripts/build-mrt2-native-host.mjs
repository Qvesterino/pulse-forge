/**
 * Build KYX's optional MRT2 companion on a supported macOS/Apple Silicon host.
 *
 * Requires MAGENTA_REALTIME_SOURCE to point at the exact upstream v2.0.3 tag.
 * The upstream CMake project fetches its pinned MLX/TFLite/SentencePiece
 * dependencies; this script never downloads or packages model weights.
 */
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = process.env.MAGENTA_REALTIME_SOURCE;
const buildDir = path.join(root, "build", "mrt2-native-host");
const outputDir = path.join(root, "build", "mrt2-host");
const outputPath = path.join(outputDir, "kyx-mrt2-host");
const EXPECTED_UPSTREAM_TAG = "v2.0.3";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "14.0", ...options.env },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + " " + args.join(" ") + " failed (" + (signal ?? "code " + code) + ")"));
    });
  });
}

function installedUpstreamTag(sourcePath) {
  try {
    return execFileSync("git", ["-C", sourcePath, "describe", "--tags", "--exact-match", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The MRT2 native host can only be built on macOS running on Apple Silicon.");
}
if (!upstream || !existsSync(path.join(upstream, "CMakeLists.txt"))) {
  throw new Error("Set MAGENTA_REALTIME_SOURCE to a local magenta-realtime source checkout.");
}
const upstreamTag = installedUpstreamTag(upstream);
if (upstreamTag !== EXPECTED_UPSTREAM_TAG) {
  throw new Error(
    "Expected magenta-realtime tag " +
      EXPECTED_UPSTREAM_TAG +
      ", found " +
      (upstreamTag || "an untagged/different checkout") +
      ".",
  );
}

const cmakeVersion = execFileSync("cmake", ["--version"], { encoding: "utf8" }).match(/cmake version (\d+)\.(\d+)/);
if (!cmakeVersion || Number(cmakeVersion[1]) < 3 || (Number(cmakeVersion[1]) === 3 && Number(cmakeVersion[2]) < 27)) {
  throw new Error("CMake 3.27 or newer is required.");
}

await mkdir(buildDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
console.log("• configure KYX MRT2 host against " + EXPECTED_UPSTREAM_TAG);
await run("cmake", [
  "-S",
  path.join(root, "native", "mrt2-host"),
  "-B",
  buildDir,
  "-DMAGENTA_REALTIME_SOURCE=" + upstream,
  "-DCMAKE_OSX_ARCHITECTURES=arm64",
  "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
  "-DCMAKE_BUILD_TYPE=Release",
]);
console.log("• build kyx-mrt2-host");
await run("cmake", ["--build", buildDir, "--target", "kyx-mrt2-host", "--config", "Release", "--parallel"]);

const candidates = [
  path.join(buildDir, "out", "kyx-mrt2-host"),
  path.join(buildDir, "out", "Release", "kyx-mrt2-host"),
];
const builtBinary = candidates.find(existsSync);
if (!builtBinary) throw new Error("CMake completed without producing kyx-mrt2-host.");
const architectures = execFileSync("lipo", ["-archs", builtBinary], { encoding: "utf8" });
if (!architectures.includes("arm64")) throw new Error("Built MRT2 host is not an Apple Silicon arm64 binary.");
await copyFile(builtBinary, outputPath);
await chmod(outputPath, 0o755);
console.log("• ready: " + outputPath);
