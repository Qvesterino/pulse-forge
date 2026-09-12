/**
 * One-off: mirror this session's vendored-core fixes back to the upstream
 * VocalForge_DAW copy (reversing the vendor header + mechanical transforms),
 * then verify the forward vendor transform reproduces the vendored files
 * byte-for-byte.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const UP = "D:/VocalForge_DAW/plugins/ultina/src";
const DST = "src/effects/ultina-core";

const HEADER = `/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
`;

function applyTransforms(source) {
  return source
    .replace(
      "import { AutoGainController, AutoGainReading } from",
      "import { AutoGainController, type AutoGainReading } from",
    )
    .replace(/const octaveBands = /, "const _octaveBands = ")
    .replace(/const maxBlockSize = /, "const _maxBlockSize = ")
    .replace(/const avgEnergy = /, "const _avgEnergy = ");
}

function reverseTransforms(source) {
  return source
    .replace(
      "import { AutoGainController, type AutoGainReading } from",
      "import { AutoGainController, AutoGainReading } from",
    )
    .replace(/const _octaveBands = /, "const octaveBands = ")
    .replace(/const _maxBlockSize = /, "const maxBlockSize = ")
    .replace(/const _avgEnergy = /, "const avgEnergy = ");
}

const FILES = [
  "dsp/multiband.ts",
  "dsp/ultinaProcessor.ts",
  "dsp/lufsMeter.ts",
  "dsp/spectralRegistry.ts",
  "dsp/modules/unmaskModule.ts",
  "dsp/modules/sculptorModule.ts",
  "dsp/modules/eqModule.ts",
  "dsp/modules/exciterModule.ts",
  "dsp/modules/clipperModule.ts",
  "dsp/modules/compModule.ts",
  "dsp/modules/gateModule.ts",
  "dsp/modules/densityModule.ts",
  "dsp/modules/transientModule.ts",
  "dsp/modules/phaseModule.ts",
];

let ok = 0;
for (const rel of FILES) {
  // Normalize CRLF → LF (some vendored files carry Windows endings; upstream
  // is LF) so the round-trip comparison is line-ending-independent.
  const vendored = readFileSync(join(DST, rel), "utf8").replace(/\r\n/g, "\n");
  if (!vendored.startsWith(HEADER)) {
    console.error("HEADER MISMATCH (vendor script changed?):", rel);
    process.exit(1);
  }
  const upstreamNew = reverseTransforms(vendored.slice(HEADER.length));
  const roundTrip = HEADER + applyTransforms(upstreamNew);
  if (roundTrip !== vendored) {
    console.error("ROUND-TRIP FAILED:", rel);
    process.exit(1);
  }
  writeFileSync(join(UP, rel), upstreamNew);
  ok++;
}
console.log(`[mirror] ${ok} files synced upstream + round-trip verified`);
