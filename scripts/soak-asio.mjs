#!/usr/bin/env node
/**
 * ASIO soak runner (ADR 0017 wave 2.5 acceptance).
 *
 *   npm run soak:asio [--seconds 300] [--name "driver name"]
 *
 * Default: the 64-bit fixture driver (SDK sample) for 300 s — paces in
 * realtime, synthesizes a bounded tone. Verifies the ADR acceptance:
 *   - exact frame count (driver-paced, 48000 × seconds)
 *   - zero sequence gaps (contiguous delivery)
 *   - zero non-finite samples
 *   - sustained the full duration without crashing (clean EOF)
 * With --name, attempts a REGISTERED hardware driver instead — 32-bit-only
 * drivers are reported honestly as unloadable from a 64-bit process.
 * Writes a JSON report to .zcode/asio-soak-report.json.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PcmPipeSource } from "../desktop/pcm-pipe.cjs";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SECONDS = Math.min(3600, Math.max(5, Number(argValue("--seconds") ?? 300)));
const RATE = 48000;
const DRIVER_NAME = argValue("--name");
const IS_FIXTURE = !DRIVER_NAME;

const hostPath = path.join(
  projectRoot,
  "native",
  "asio-host",
  "build",
  "Release",
  "asio-host.exe",
);
if (!existsSync(hostPath)) {
  console.error(`[soak] asio-host missing (${hostPath}) — run npm run build:asio-probe`);
  process.exit(1);
}

const args = DRIVER_NAME
  ? ["--name", DRIVER_NAME, "--seconds", String(SECONDS)]
  : [
      "--dll",
      path.join(projectRoot, "native", "asio-host", "build", "Release", "asio-fixture.dll"),
      "--rate",
      String(RATE),
      "--seconds",
      String(SECONDS),
    ];

console.log(`[soak] ${SECONDS} s @ ${RATE} Hz — ${DRIVER_NAME ? `hardware driver "${DRIVER_NAME}"` : "fixture driver"}`);
const source = new PcmPipeSource({ hostPath, args });

let frames = 0;
let nonFinite = 0;
let outOfBands = 0;
let startedAt = 0;
let lastProgress = 0;
let driverFrames = null;
let done = false;

const verdict = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("soak exceeded the hard deadline (SECONDS*4+30 s)")), SECONDS * 4000 + 30_000);
  source.on("format", (f) => {
    startedAt = Date.now();
    console.log(`[soak] format: ${JSON.stringify(f)}`);
  });
  source.on("pcm", (raw) => {
    const block = raw;
    const arr = block.samples;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (!Number.isFinite(s)) nonFinite++;
      else if (s < -1.001 || s > 1.001) outOfBands++;
    }
    frames += arr.length / 2;
    const elapsed = (Date.now() - startedAt) / 1000;
    if (startedAt && elapsed - lastProgress >= 30) {
      lastProgress = elapsed;
      const drift = frames / (elapsed * RATE);
      console.log(`[soak] ${elapsed.toFixed(0).padStart(4)} s | ${frames.toLocaleString()} frames | drift ${drift.toFixed(3)}× realtime`);
    }
  });
  source.on("stats", (e) => {
    if (e && typeof e === "object" && "framesWritten" in e) driverFrames = e;
  });
  source.on("protocol-error", (m) => {
    clearTimeout(timer);
    reject(new Error(`protocol: ${m}`));
  });
  source.on("close", (payload) => {
    clearTimeout(timer);
    done = true;
    resolve({ close: payload, elapsed: (Date.now() - startedAt) / 1000 });
  });
  source.start();
});

const stats = verdict.close.stats;
const expected = SECONDS * RATE;
const checks = {
  "frame count exact": stats.pcmFramesReceived === expected,
  "zero seq gaps": stats.seqGaps === 0,
  "zero non-finite samples": nonFinite === 0,
  "zero out-of-band samples": outOfBands === 0,
  "driver EOF reached": done && stats.ended === true,
  "sustained realtime (≥0.9×)": verdict.elapsed >= SECONDS * 0.9,
};
const pass = Object.values(checks).every(Boolean);

console.log("");
console.log("=== ASIO SOAK VERDICT ===");
for (const [name, ok] of Object.entries(checks)) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`  frames ${stats.pcmFramesReceived.toLocaleString()} / expected ${expected.toLocaleString()} | seqGaps ${stats.seqGaps} | nonFinite ${nonFinite} | elapsed ${verdict.elapsed.toFixed(1)} s`);

const report = {
  at: new Date().toISOString(),
  driver: DRIVER_NAME ?? "fixture (SDK sample driver, 64-bit)",
  seconds: SECONDS,
  rate: RATE,
  frames: stats.pcmFramesReceived,
  expected,
  seqGaps: stats.seqGaps,
  nonFinite,
  outOfBands,
  elapsedS: Number(verdict.elapsed.toFixed(1)),
  pass,
  checks,
};
const reportDir = path.join(projectRoot, ".zcode");
mkdirSync(reportDir, { recursive: true });
writeFileSync(path.join(reportDir, "asio-soak-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`[soak] report: .zcode/asio-soak-report.json`);
process.exit(pass ? 0 : 1);
