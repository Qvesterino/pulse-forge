/**
 * Re-vendor the Ultina DSP core from VocalForge_DAW into Pulse Forge.
 *
 *   node scripts/vendor-ultina.mjs [--from D:/VocalForge_DAW/plugins/ultina]
 *
 * A sync requires a clean upstream tree and a source/vendor match before any
 * file is written. For a reviewed replacement of an intentional vendor drift,
 * add --allow-vendor-drift; for a deliberately uncommitted upstream source,
 * add --allow-dirty-upstream as well.
 *
 * POLICY (2026-09-14): the vendored core is intentionally ALLOWED TO DIVERGE
 * from upstream — Pulse Forge treats it as its own hardened copy (owner
 * decision). Re-vendoring is an opt-in, lossy operation: reconciled markers
 * (see the preflight below) list the in-place fixes a sync would drop.
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
const ALLOW_VENDOR_DRIFT = process.argv.includes("--allow-vendor-drift");
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
 * source-of-truth sync is being reviewed immediately afterwards. A clean
 * upstream is not enough on its own: if the existing vendor has a different
 * source body, the sync also requires --allow-vendor-drift so this script
 * cannot partially replace a newer local hardening pass with an older source.
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

/** Reconciled markers in a file (header-independent: everything after the
 *  first standalone comment-terminator line is compared). */
function reconciledMarkers(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const bodyStart = lines.findIndex((l) => l.trim() === "*/") + 1;
  return new Set(
    lines
      .slice(bodyStart)
      .filter((l) => l.includes("Reconciled from Pulse Forge"))
      .map((l) => l.trim()),
  );
}

const preparedFiles = [];
const vendorDrift = [];
const lostMarkers = [];
for (const rel of FILES) {
  const abs = join(SRC, rel);
  if (!existsSync(abs)) {
    console.error("MISSING upstream file: " + abs);
    process.exit(1);
  }
  const out = join(DST, rel);
  const expected = HEADER + applyTransforms(readFileSync(abs, "utf8"));
  if (existsSync(out) && readFileSync(out, "utf8") !== expected) {
    vendorDrift.push(rel);
    // A drift entry MAY be a local reconciled fix — those need an explicit,
    // acknowledged decision even when --allow-vendor-drift is passed.
    const lost = [...reconciledMarkers(readFileSync(out, "utf8"))].filter(
      (l) => !reconciledMarkers(readFileSync(abs, "utf8")).has(l),
    );
    if (lost.length > 0) lostMarkers.push({ rel, lost });
  }
  preparedFiles.push({ rel, out, expected });
}

if (lostMarkers.length > 0 && !process.argv.includes("--drop-reconciled")) {
  console.error(
    "[vendor] ABORTED — nothing written. The vendored Ultina core is " +
      "allowed to diverge from upstream (owner decision, 2026-09-14) and " +
      "carries reconciled fixes the upstream snapshot does NOT have; " +
      "syncing now would silently revert them:\n" +
      lostMarkers
        .map(({ rel, lost }) => `  ${rel}:\n${lost.map((l) => `    ${l}`).join("\n")}`)
        .join("\n") +
      "\nPort them upstream first, or pass --drop-reconciled (together with " +
      "--allow-vendor-drift) when you really mean to drop them.",
  );
  process.exit(1);
}

if (vendorDrift.length && !ALLOW_VENDOR_DRIFT) {
  console.error(
    "[vendor] REFUSING vendor drift before write:\n" +
    vendorDrift.map((rel) => `M ${rel}`).join("\n") + "\n" +
    "Review the source/vendor diff, then rerun with --allow-vendor-drift " +
    "for an intentional upstream→vendor replacement.",
  );
  process.exit(1);
}

for (const { rel, out, expected } of preparedFiles) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, expected);
}
console.log(`[vendor] ${FILES.length} DSP files -> ${DST}`);

// Golden vectors (data files — copied as-is).
mkdirSync("tests/ultina-vectors", { recursive: true });
for (const name of readdirSync(join(FROM, "tests/vectors")).filter((f) => f.endsWith(".json"))) {
  copyFileSync(join(FROM, "tests/vectors", name), join("tests/ultina-vectors", name));
}
console.log("[vendor] golden vectors synced");
