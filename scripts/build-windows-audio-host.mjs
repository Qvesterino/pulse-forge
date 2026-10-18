#!/usr/bin/env node
/** Build and verify the Windows WASAPI shared-duplex adapter core. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(root, "native", "windows-audio-host");
const build = path.join(root, "build", "windows-audio-host");
const executable = path.join(build, "Release", "kyx-windows-audio-channel-map-tests.exe");
const hostLibrary = path.join(build, "Release", "kyx-windows-audio-shared-duplex.lib");
const addon = path.join(source, "build", "Release", "kyx_windows_audio_host.node");
const nodeGyp = path.join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");

if (process.platform !== "win32") {
  console.log("[windows-audio-host] Skipping the Windows-only C++ target.");
  process.exit(0);
}

function findCmake() {
  const configured = process.env.CMAKE_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  try {
    execFileSync("cmake", ["--version"], { stdio: "ignore", timeout: 5000 });
    return "cmake";
  } catch {
    /* Try the Visual Studio CMake bundled with this Windows toolchain. */
  }
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    try {
      const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      const candidate = path.join(
        installation,
        "Common7",
        "IDE",
        "CommonExtensions",
        "Microsoft",
        "CMake",
        "CMake",
        "bin",
        "cmake.exe",
      );
      if (installation && existsSync(candidate)) return candidate;
    } catch {
      /* Report the common actionable error below. */
    }
  }
  throw new Error(
    "CMake was not found. Install CMake or Visual Studio C++ build tools to build KYX Studio for Windows.",
  );
}

const cmake = findCmake();
function run(args) {
  console.log(`[windows-audio-host] ${args.join(" ")}`);
  execFileSync(cmake, args, { cwd: root, stdio: "inherit", timeout: 180_000 });
}

run(["-S", source, "-B", build, "-A", "x64"]);
run(["--build", build, "--config", "Release"]);
const ctest = path.join(path.dirname(cmake === "cmake" ? process.execPath : cmake), "ctest.exe");
const ctestExecutable = existsSync(ctest) ? ctest : "ctest";
execFileSync(ctestExecutable, ["--test-dir", build, "-C", "Release", "--output-on-failure"], {
  cwd: root,
  stdio: "inherit",
  timeout: 60_000,
});

if (!existsSync(nodeGyp)) {
  throw new Error("node-gyp was not found in node_modules; run `npm install` before building the Electron audio host.");
}
const electronPackage = JSON.parse(readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8"));
const nodeOptions = [process.env.NODE_OPTIONS, "--use-system-ca"].filter(Boolean).join(" ");
const gypArgs = [
  nodeGyp,
  "rebuild",
  `--directory=${source}`,
  `--target=${electronPackage.version}`,
  "--dist-url=https://electronjs.org/headers",
  "--arch=x64",
];
console.log(`[windows-audio-host] ${gypArgs.slice(1).join(" ")}`);
execFileSync(process.execPath, gypArgs, {
  cwd: root,
  stdio: "inherit",
  timeout: 180_000,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

if (!existsSync(executable)) throw new Error(`build claimed success but ${executable} is missing`);
if (!existsSync(hostLibrary)) throw new Error(`build claimed success but ${hostLibrary} is missing`);
if (!existsSync(addon)) throw new Error(`build claimed success but ${addon} is missing`);
console.log(`[windows-audio-host] OK — ${hostLibrary}, ${addon}, and CTest targets`);
