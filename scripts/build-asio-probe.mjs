#!/usr/bin/env node
/**
 * Build the native ASIO driver probe (ADR 0017):
 *
 *   npm run build:asio-probe
 *
 * Requires the SDK headers first (`npm run vendor:asio` — Steinberg license
 * gate, see scripts/vendor-asio.mjs). Without them the configure step warns
 * and this script exits 0 with an honest skip notice: no SDK, no probe, and
 * every consumer must handle "probe missing" gracefully.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "native/asio-host";
const BUILD = join(SOURCE, "build");

if (!existsSync(join(SOURCE, "asio-sdk", "common", "iasiodrv.h"))) {
  console.log("[asio-probe] ASIO SDK headers not vendored — run `npm run vendor:asio` (Steinberg license gate).");
  console.log("[asio-probe] Skipping the native build; the manager falls back to registry-only discovery.");
  process.exit(0);
}

function run(args) {
  console.log(`[asio-probe] ${args.join(" ")}`);
  execFileSync(args[0], args.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
}

try {
  run(["cmake", "-S", SOURCE, "-B", BUILD]);
} catch {
  console.log("[asio-probe] default generator failed — retrying with Visual Studio 17 2022 (x64)");
  run(["cmake", "-S", SOURCE, "-B", BUILD, "-G", "Visual Studio 17 2022", "-A", "x64"]);
}
run(["cmake", "--build", BUILD, "--config", "Release"]);

const exe = join(BUILD, "Release", "asio-probe.exe");
if (!existsSync(exe)) throw new Error(`build claimed success but ${exe} is missing`);
console.log(`[asio-probe] OK — ${exe}`);
