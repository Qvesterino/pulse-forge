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
import { execFileSync } from "child_process";
import { dirname, join, relative, resolve } from "path";

const fromIndex = process.argv.indexOf("--from");
const FROM = fromIndex >= 0
  ? process.argv[fromIndex + 1]
  : "D:/VocalForge_DAW/plugins/ultina";
const ALLOW_DIRTY_UPSTREAM = process.argv.includes("--allow-dirty-upstream");
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

/**
 * Refuse a blind overwrite when the source repository has uncommitted files
 * in the exact tree this script copies. The old behaviour could silently
 * replace already-vendored hardening with an older or partial upstream
 * working tree. Use --allow-dirty-upstream only when an intentional local
 * source-of-truth sync is being reviewed immediately afterwards.
 */
function assertUpstreamClean() {
  if (ALLOW_DIRTY_UPSTREAM) return;
  try {
    const gitRoot = execFileSync("git", ["-C", FROM, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const scope = relative(resolve(gitRoot), resolve(FROM)).replace(/\\/g, "/");
    const dirty = execFileSync(
      "git",
      ["-C", gitRoot, "status", "--porcelain=v1", "--", `${scope}/src`, `${scope}/tests/vectors`],
      { encoding: "utf8" },
    ).trim();
    if (dirty) {
      console.error(
        `[vendor] REFUSING dirty upstream: ${FROM}\n` +
        `${dirty}\n` +
        "Commit or separate the upstream changes first, or rerun with " +
        "--allow-dirty-upstream after reviewing the complete source diff.",
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(
      `[vendor] cannot verify upstream Git state for ${FROM}. ` +
      "Use --allow-dirty-upstream only for a reviewed non-Git source tree.",
    );
    process.exit(1);
  }
}

assertUpstreamClean();

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
