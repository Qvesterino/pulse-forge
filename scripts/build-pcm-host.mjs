#!/usr/bin/env node
/**
 * Build the reference PCM pipe host (ADR 0018):
 *
 *   npm run build:pcm-host
 *
 * C-only, no SDK gate — this host needs no audio hardware. The wave-2 ASIO
 * streaming host reuses this CMake tree once a driver is available.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "native/pcm-host";
const BUILD = join(SOURCE, "build");

function run(args) {
  console.log(`[pcm-host] ${args.join(" ")}`);
  execFileSync(args[0], args.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
}

try {
  run(["cmake", "-S", SOURCE, "-B", BUILD]);
} catch {
  console.log("[pcm-host] default generator failed — retrying with Visual Studio 17 2022 (x64)");
  run(["cmake", "-S", SOURCE, "-B", BUILD, "-G", "Visual Studio 17 2022", "-A", "x64"]);
}
run(["cmake", "--build", BUILD, "--config", "Release"]);

const exe = join(BUILD, "Release", "pcm-gen.exe");
if (!existsSync(exe)) throw new Error(`build claimed success but ${exe} is missing`);
console.log(`[pcm-host] OK — ${exe}`);
