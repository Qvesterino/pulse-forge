/**
 * One-off (2026-09-08): push the Pulse Forge reconciled Ozvena fixes to the
 * upstream VocalForge_DAW source so a future re-vendor is lossless.
 *
 *   node scripts/sync-ozvena-upstream.mjs [--to D:/VocalForge_DAW/plugins/ozvena]
 *
 * For each file below, the Pulse Forge vendored copy (minus the 13-line
 * provenance header) is written over the upstream source, converted to the
 * upstream's CRLF line endings. The Pulse Forge copies are the superset:
 * every reconciled audit fix (reset scalars, pre-delay ring-growth
 * continuity, plate readTap hoist, limiter stale-lookahead zeroing, the
 * factory-IR provider hook) on top of the last vendored snapshot.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TO = process.argv.includes("--to")
  ? process.argv[process.argv.indexOf("--to") + 1]
  : "D:/VocalForge_DAW/plugins/ozvena";

const FILES = [
  "core/ozvenaProcessor.ts",
  "engines/convolutionEngine.ts",
  "engines/plateChamberEngine.ts",
  "modules/preDelay.ts",
  "modules/safetyLimiter.ts",
  "dsp/fftPartitioned.ts",
];

// The vendored header is exactly this many lines (see vendor-ozvena.mjs).
const VENDOR_HEADER_LINES = 13;

for (const rel of FILES) {
  const pf = readFileSync(join("src/effects/ozvena-core", rel), "utf8");
  const body = pf.split("\n").slice(VENDOR_HEADER_LINES).join("\n");
  const crlf = body.replace(/\n/g, "\r\n");
  writeFileSync(join(TO, "src", rel), crlf);
  console.log(`[sync] ${rel} -> ${TO}/src/${rel} (CRLF, ${crlf.length} bytes)`);
}
console.log("[sync] done — upstream now matches the Pulse Forge reconciled core.");
console.log("[sync] verify upstream with its own test suite, then re-vendor freely.");
