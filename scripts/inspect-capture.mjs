/**
 * Extract a still frame from a webm so the footage can be verified by eye
 * before it goes into the demo. Uses ffmpeg if present, otherwise reports.
 *
 * Usage: node scripts/inspect-capture.mjs <webm> <outPng> [timestampSeconds]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const [, , input, out, ts = "6"] = process.argv;
if (!input || !out) {
  console.error("Usage: node scripts/inspect-capture.mjs <webm> <outPng> [seconds]");
  process.exit(2);
}

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasFfmpeg()) {
  console.log("ffmpeg not available — cannot extract stills.");
  process.exit(1);
}

execFileSync("ffmpeg", [
  "-y",
  "-ss",
  ts,
  "-i",
  input,
  "-frames:v",
  "1",
  "-q:v",
  "2",
  out,
]);
console.log("wrote", out, existsSync(out) ? "(ok)" : "(MISSING)");
