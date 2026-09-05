/**
 * Re-vendor the Ultina DSP core from VocalForge_DAW into Pulse Forge.
 *
 *   node scripts/vendor-ultina.mjs [--from D:/VocalForge_DAW/plugins/ultina]
 *
 * Copies the ultinaProcessor import closure + all 10 module processors +
 * moduleFactories, prepends the provenance header, applies mechanical
 * transforms, and syncs golden vectors. Then run:
 *
 *   npx vitest run tests/ultina-vectors.test.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";

const FROM = process.argv.includes("--from")
  ? process.argv[process.argv.indexOf("--from") + 1]
  : "D:/VocalForge_DAW/plugins/ultina";
const SRC = join(FROM, "src");
const DST = "src/effects/ultina-core";

const FILES = [
  "contracts/meters.ts",
  "contracts/moduleGraph.ts",
  "contracts/moduleTypes.ts",
  "contracts/parameterIds.ts",
  "contracts/parameterSchema.ts",
  "contracts/state.ts",
  "dsp/autoGain.ts",
  "dsp/crossoverLearn.ts",
  "dsp/eqLearn.ts",
  "dsp/lufsMeter.ts",
  "dsp/moduleGraphRuntime.ts",
  "dsp/moduleFactories.ts",
  "dsp/multiband.ts",
  "dsp/maskingMeter.ts",
  "dsp/fft.ts",
  "dsp/oversampler.ts",
  "dsp/dryDelay.ts",
  "contracts/channelModes.ts",
  "dsp/primitives.ts",
  "dsp/spectralRegistry.ts",
  "dsp/spectrumAnalyzer.ts",
  "dsp/ultinaProcessor.ts",
  "dsp/modules/clipperModule.ts",
  "dsp/modules/compModule.ts",
  "dsp/modules/densityModule.ts",
  "dsp/modules/eqModule.ts",
  "dsp/modules/exciterModule.ts",
  "dsp/modules/gateModule.ts",
  "dsp/modules/phaseModule.ts",
  "dsp/modules/sculptorModule.ts",
  "dsp/modules/transientModule.ts",
  "dsp/modules/unmaskModule.ts",
  "presets/factoryPresets.ts",
  "analysis/assistant.ts",
  "analysis/explanation.ts",
  "analysis/featureExtractor.ts",
  "analysis/index.ts",
  "analysis/instrumentClassifier.ts",
  "analysis/mixAssistant.ts",
  "analysis/proposalEngine.ts",
  "analysis/targetLibrary.ts",
  "analysis/tonalBalance.ts",
  "analysis/trackEnhance.ts",
];

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

/** Mechanical transforms — extend only with type-marker fixes. */
function applyTransforms(source) {
  // Analysis-layer unused locals (upstream tsconfig is laxer than ours).
  return source
    // AutoGainReading appears last in its import list (no trailing comma).
    .replace(
      "import { AutoGainController, AutoGainReading } from",
      "import { AutoGainController, type AutoGainReading } from",
    )
    .replace(/const octaveBands = /, "const _octaveBands = ")
    .replace(/const maxBlockSize = /, "const _maxBlockSize = ")
    .replace(/const avgEnergy = /, "const _avgEnergy = ");
}

for (const rel of FILES) {
  const abs = join(SRC, rel);
  if (!existsSync(abs)) {
    console.error("MISSING upstream file: " + abs);
    process.exit(1);
  }
  const out = join(DST, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, HEADER + applyTransforms(readFileSync(abs, "utf8")));
}
console.log(`[vendor] ${FILES.length} DSP files -> ${DST}`);

// Golden vectors (data files — copied as-is).
mkdirSync("tests/ultina-vectors", { recursive: true });
for (const name of readdirSync(join(FROM, "tests/vectors")).filter((f) => f.endsWith(".json"))) {
  copyFileSync(join(FROM, "tests/vectors", name), join("tests/ultina-vectors", name));
}
console.log("[vendor] golden vectors synced");
