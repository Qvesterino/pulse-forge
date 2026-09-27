#!/usr/bin/env node
/**
 * Build the native CLAP probe + test fixtures (ADR 0016):
 *
 *   npm run build:clap-probe
 *
 * Configures with the platform default generator and falls back to the
 * Visual Studio 2022 x64 generator (the probe is Windows-only in Wave 1).
 * Prints the artifact paths on success; exits nonzero with the toolchain
 * error otherwise (no toolchain = honest failure, see the ADR support matrix).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "native/clap-probe";
const HOST_SOURCE = "native/clap-host";
const BUILD = join(SOURCE, "build");
const HOST_BUILD = join(HOST_SOURCE, "build");

function run(args) {
  console.log(`[clap-probe] ${args.join(" ")}`);
  execFileSync(args[0], args.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
}

try {
  run(["cmake", "-S", SOURCE, "-B", BUILD]);
} catch {
  console.log("[clap-probe] default generator failed — retrying with Visual Studio 17 2022 (x64)");
  run(["cmake", "-S", SOURCE, "-B", BUILD, "-G", "Visual Studio 17 2022", "-A", "x64"]);
}
run(["cmake", "--build", BUILD, "--config", "Release"]);

const exe = join(BUILD, "Release", "clap-probe.exe");
if (!existsSync(exe)) throw new Error(`build claimed success but ${exe} is missing`);
console.log(`[clap-probe] OK — ${exe}`);

// Wave: CLAP audio hosting — tone fixture + player host (same SDK include).
try {
  run(["cmake", "-S", HOST_SOURCE, "-B", HOST_BUILD]);
  run(["cmake", "--build", HOST_BUILD, "--config", "Release"]);
  const player = join(HOST_BUILD, "Release", "clap-player.exe");
  if (!existsSync(player)) throw new Error(`${player} missing`);
  console.log(`[clap-probe] OK — ${player}`);
  console.log(`[clap-probe] tone fixture: ${join(HOST_BUILD, "Release", "clap-tone.clap")}`);
} catch (err) {
  console.error(`[clap-probe] clap-host build failed: ${err?.message ?? err}`);
  process.exitCode = 1;
}
console.log(
  `[clap-probe] fixtures: ${join(BUILD, "Release", "clap-fixture.clap")}, ${join(BUILD, "Release", "clap-fixture-empty.clap")}`,
);
