#!/usr/bin/env node
/** Build and verify the metadata-only WASAPI endpoint discovery helper. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(root, "native", "windows-audio-probe");
const build = path.join(root, "build", "windows-audio-probe");
const executable = path.join(build, "Release", "kyx-windows-audio-probe.exe");

if (process.platform !== "win32") {
  console.log("[windows-audio-probe] Skipping the Windows-only Core Audio helper.");
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
  console.log(`[windows-audio-probe] ${args.join(" ")}`);
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

if (!existsSync(executable)) throw new Error(`build claimed success but ${executable} is missing`);
console.log(`[windows-audio-probe] OK — ${executable}`);
