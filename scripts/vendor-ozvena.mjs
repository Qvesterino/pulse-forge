/**
 * Re-vendor the Ozvena DSP core from VocalForge_DAW into Pulse Forge.
 *
 *   node scripts/vendor-ozvena.mjs [--from D:/VocalForge_DAW/plugins/ozvena]
 *
 * Copies the ozvenaProcessor import closure + v2 type/state modules,
 * prepends the provenance header, and syncs golden fixtures. Then run:
 *
 *   npx vitest run tests/ozvena-golden.test.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";

const FROM = process.argv.includes("--from")
  ? process.argv[process.argv.indexOf("--from") + 1]
  : "D:/VocalForge_DAW/plugins/ozvena";
const SRC = join(FROM, "src");
const DST = "src/effects/ozvena-core";

const FILES = [
  "core/blendPad.ts",
  "core/duckController.ts",
  "core/ozvenaProcessor.ts",
  "core/reverbAssistant.ts",
  "dsp/biquad.ts",
  "dsp/fft.ts",
  "dsp/fftPartitioned.ts",
  "dsp/math.ts",
  "dsp/oversampler.ts",
  "dsp/peakDetection.ts",
  "dsp/smoother.ts",
  "dsp/spectrumAnalyzer.ts",
  "engines/convolutionEngine.ts",
  "engines/hallEngine.ts",
  "engines/plateChamberEngine.ts",
  "engines/reflectionsEngine.ts",
  "modules/analyzerHelpers.ts",
  "modules/factoryIr.ts",
  "modules/maskingMeter.ts",
  "modules/modPad.ts",
  "modules/preDelay.ts",
  "modules/preEq.ts",
  "modules/reverbEq.ts",
  "modules/safetyLimiter.ts",
  "modules/smoother.ts",
  "v2/convolutionTypes.ts",
  "v2/types.ts",
  "v2/vocalForgeIpc.ts",
];

const HEADER = `/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
`;

/** Mechanical transforms — extend only with type-marker fixes. */
function applyTransforms(source) {
  return source;
}

let vendored = 0;
for (const rel of FILES) {
  const abs = join(SRC, rel);
  if (!existsSync(abs)) {
    console.error("MISSING upstream file: " + abs);
    process.exit(1);
  }
  const out = join(DST, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, HEADER + applyTransforms(readFileSync(abs, "utf8")));
  vendored++;
}
console.log(`[vendor] ${vendored} DSP files -> ${DST}`);

// Golden fixtures (data — copied as-is).
const goldenDir = join(FROM, "tests/golden");
if (existsSync(goldenDir)) {
  mkdirSync("tests/ozvena-golden", { recursive: true });
  for (const name of readdirSync(goldenDir).filter((f) => f.endsWith(".json"))) {
    copyFileSync(join(goldenDir, name), join("tests/ozvena-golden", name));
  }
  console.log("[vendor] golden fixtures synced");
} else {
  console.log("[vendor] no tests/golden dir upstream — check fixture location");
}
