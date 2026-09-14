/**
 * Re-vendor the Ozvena DSP core from VocalForge_DAW into Pulse Forge.
 *
 *   node scripts/vendor-ozvena.mjs [--from D:/VocalForge_DAW/plugins/ozvena]
 *                                  [--force-reconciled]
 *
 * Copies the ozvenaProcessor import closure + v2 type/state modules,
 * prepends the provenance header, and syncs golden fixtures. Then run:
 *
 *   npx vitest run tests/ozvena-golden.test.ts
 *
 * SAFETY: the vendored copy carries in-place audit fixes marked with
 * "(Reconciled from Pulse Forge …)" comments. If the destination has
 * reconciled markers the incoming upstream snapshot LACKS, the script
 * aborts — re-vendoring would silently revert live fixes. Sync them
 * upstream first (see scripts/sync-ozvena-upstream.mjs), or pass
 * --force-reconciled when you really mean to drop them.
 *
 * POLICY (2026-09-14): the vendored core is intentionally ALLOWED TO
 * DIVERGE from upstream — Pulse Forge treats it as its own hardened copy
 * (owner decision). Upstream parity of the fixtures is a historical
 * regression baseline, not a requirement.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";

const FROM = process.argv.includes("--from")
  ? process.argv[process.argv.indexOf("--from") + 1]
  : "D:/VocalForge_DAW/plugins/ozvena";
const SRC = join(FROM, "src");
const DST = "src/effects/ozvena-core";
const FORCE = process.argv.includes("--force-reconciled");

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
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a semantics-faithful copy of the upstream DSP oracle (line endings are
 * normalized) so Pulse Forge and
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

/** Keep generated vendored sources stable across the upstream repository's
 * historical CRLF/CRCRLF line-ending variants. This is whitespace-only and
 * does not alter the DSP body. */
function normalizeLineEndings(source) {
  return source.replace(/\r\r\n/g, "\n").replace(/\r\n?/g, "\n");
}

/** Lines carrying an in-place audit-fix marker. Comparison is
 *  whitespace-insensitive: the vendored copies have mixed line endings
 *  (historical CRLF/LF churn), and a stray trailing \r must not fake a
 *  conflict — or hide a real one. */
function reconciledMarkers(text) {
  const set = new Set(
    text
      .replace(/\r/g, "")
      .split("\n")
      .filter((l) => l.includes("Reconciled from Pulse Forge"))
      .map((l) => l.trim()),
  );
  return set;
}

// Preflight: compare reconciled markers BEFORE touching any file, so an
// abort leaves the vendored tree untouched.
const conflicts = [];
const upstreamSources = new Map();
for (const rel of FILES) {
  const abs = join(SRC, rel);
  if (!existsSync(abs)) {
    console.error("MISSING upstream file: " + abs);
    process.exit(1);
  }
  const upstream = readFileSync(abs, "utf8");
  upstreamSources.set(rel, upstream);
  const out = join(DST, rel);
  if (existsSync(out)) {
    // Strip the vendored header from the current copy before comparing:
    // markers live in body comments, the header is prepended by us.
    const current = readFileSync(out, "utf8").split("\n").slice(13).join("\n");
    const lost = [...reconciledMarkers(current)].filter(
      (l) => !reconciledMarkers(upstream).has(l),
    );
    if (lost.length > 0) {
      conflicts.push(`  ${rel}:\n${lost.map((l) => `    ${l}`).join("\n")}`);
    }
  }
}

if (conflicts.length > 0 && !FORCE) {
  console.error(
    "[vendor] ABORTED — nothing written. The vendored copy carries " +
      "reconciled fixes that the upstream snapshot does NOT have; " +
      "re-vendoring now would silently revert them. Sync them upstream " +
      "first (scripts/sync-ozvena-upstream.mjs), or pass --force-reconciled " +
      "to drop them:\n" +
      conflicts.join("\n"),
  );
  process.exit(1);
}

let vendored = 0;
for (const rel of FILES) {
  const out = join(DST, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, HEADER + normalizeLineEndings(applyTransforms(upstreamSources.get(rel))));
  vendored++;
}
console.log(`[vendor] ${vendored} DSP files -> ${DST}`);
if (conflicts.length > 0) {
  console.warn("[vendor] --force-reconciled: dropped reconciled fixes in:\n" + conflicts.join("\n"));
}

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
