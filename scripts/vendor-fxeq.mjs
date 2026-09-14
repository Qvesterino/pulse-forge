/**
 * Re-vendor the FXEQ DSP core from VocalForge_DAW into Pulse Forge.
 *
 *   node scripts/vendor-fxeq.mjs [--from D:/VocalForge_DAW/plugins/fxeq]
 *                                [--force-reconciled]
 *
 * Copies the exact import closure of the v1 processor (core/dsp/modules),
 * prepends the provenance header, applies the documented mechanical
 * transforms, and syncs the golden fixtures + harness. After re-vendoring,
 * run the parity suite:
 *
 *   npx vitest run tests/fxeq-golden.test.ts
 *
 * POLICY (2026-09-14): the vendored core is intentionally ALLOWED TO
 * DIVERGE from upstream — Pulse Forge treats it as its own hardened copy
 * (owner decision). Re-vendoring is an opt-in, lossy operation.
 *
 * SAFETY: the vendored copy carries in-place fixes marked with
 * "(Reconciled from Pulse Forge …)" comments. If the destination has
 * reconciled markers the incoming upstream snapshot LACKS, the script
 * aborts — re-vendoring would silently revert live fixes. Port them
 * upstream first, or pass --force-reconciled when you really mean to
 * drop them.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "fs";
import { dirname, join } from "path";

const FROM = process.argv.includes("--from")
  ? process.argv[process.argv.indexOf("--from") + 1]
  : "D:/VocalForge_DAW/plugins/fxeq";
const SRC = join(FROM, "src");
const DST = "src/effects/fxeq-core";
const FORCE = process.argv.includes("--force-reconciled");

const FILES = [
  "core/bandEngine.ts",
  "core/commandHistory.ts",
  "core/crossover.ts",
  "core/fxEqProcessor.ts",
  "core/parameterSchema.ts",
  "core/presets.ts",
  "core/signalFlow.ts",
  "dsp/audioBlockContract.ts",
  "dsp/biquad.ts",
  "dsp/crossoverStage.ts",
  "dsp/dynamics.ts",
  "dsp/envelope.ts",
  "dsp/lfo.ts",
  "dsp/mathUtils.ts",
  "dsp/oversampledSaturation.ts",
  "dsp/oversampler.ts",
  "dsp/types.ts",
  "dsp/waveshapers.ts",
  "modules/delay.ts",
  "modules/dynamics.ts",
  "modules/limiter.ts",
  "modules/lofi.ts",
  "modules/modulation.ts",
  "modules/moduleHelpers.ts",
  "modules/reverb.ts",
  "modules/saturation.ts",
];

const HEADER = `/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
`;

/** Mechanical transforms — keep in sync with the header. */
function applyTransforms(source) {
  return source
    .replace(/^(  )CrossoverStage,$/m, "$1type CrossoverStage,")
    .replace(/^(  )CrossoverOrder,$/m, "$1type CrossoverOrder,")
    .replace(/^(  )BiquadState,$/m, "$1type BiquadState,")
    .replace(/import \{ BiquadState, createBiquad/g, "import { type BiquadState, createBiquad");
}

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

// Preflight: compare reconciled markers BEFORE touching any file, so an
// abort leaves the vendored tree untouched.
const conflicts = [];
for (const rel of FILES) {
  const abs = join(SRC, rel);
  if (!existsSync(abs)) {
    console.error("MISSING upstream file: " + abs);
    process.exit(1);
  }
  const upstream = readFileSync(abs, "utf8");
  const out = join(DST, rel);
  if (existsSync(out)) {
    const lost = [...reconciledMarkers(readFileSync(out, "utf8"))].filter(
      (l) => !reconciledMarkers(upstream).has(l),
    );
    if (lost.length > 0) {
      conflicts.push(`  ${rel}:\n${lost.map((l) => `    ${l}`).join("\n")}`);
    }
  }
}

if (conflicts.length > 0 && !FORCE) {
  console.error(
    "[vendor] ABORTED — nothing written. The vendored FXEQ core is allowed " +
      "to diverge from upstream (owner decision, 2026-09-14) and carries " +
      "reconciled fixes the upstream snapshot does NOT have; re-vendoring " +
      "now would silently revert them. Port them upstream first, or pass " +
      "--force-reconciled to drop them:\n" +
      conflicts.join("\n"),
  );
  process.exit(1);
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

// Golden fixtures + harness (adaptable copies, not byte-faithful).
mkdirSync("tests/fxeq-golden", { recursive: true });
for (const name of readdirSync(join(FROM, "tests/golden")).filter((f) => f.endsWith(".json"))) {
  copyFileSync(join(FROM, "tests/golden", name), join("tests/fxeq-golden", name));
}
console.log("[vendor] golden fixtures synced (cases/helpers live in tests/fxeq-golden/, adapt imports if upstream moves)");
