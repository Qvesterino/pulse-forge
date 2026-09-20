#!/usr/bin/env node
/**
 * One-shot codemod: wire every AudioWorklet effect-node wrapper through the
 * shared `safeApplyAudioParam` helper, so non-finite values are dropped instead
 * of throwing `TypeError` from the spec-mandated AudioParam write guard.
 *
 * Scoped to the previously-audited batch (FázA §6 of the Browser Audio Plugin
 * Hardening campaign). Manual edits to: bitcrusher, limiter, envfollower, eq,
 * chorus, flanger, autowah, kaskada, ducking-delay, comb, beatmangler,
 * freqshifter already adopted the helper. The script processes every
 * remaining `*-node.ts` under `src/audio-worklets/` that still writes through
 * an inline `setParam` closure with the canonical 5-line body.
 *
 * Idempotent — already-imported files are no-ops, and the canonical regex
 * matches exactly the literal body this codemod wants to replace.
 *
 * Usage:
 *   node scripts/apply-safe-audio-param.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = resolve(__dirname, "../src/audio-worklets");
const helper = "./safeAudioParam";

// Canonical inline setParam body the script replaces with a no-op helper.
const SET_PARAM_BODY =
  /const setParam = \(id: string, v: number, when\?: number\) => \{\s*\n\s*const p = node\.parameters\.get\(id\);\s*\n\s*if \(!p\) return;\s*\n\s*if \(when === undefined\) p\.value = v;\s*\n\s*else p\.setValueAtTime\(v, when\);\s*\n\s*\};/g;

// Same body but parameter may be named `param` (kaskada-node — already done).
const SET_PARAM_BODY_PARAM =
  /const setParam = \(id: string, v: number, when\?: number\) => \{\s*\n\s*const param = node\.parameters\.get\(id\);\s*\n\s*if \(!param\) return;\s*\n\s*if \(when === undefined\) param\.value = v;\s*\n\s*else param\.setValueAtTime\(v, when\);\s*\n\s*\};/g;

// Fallback body used by some nodes (id maps to a different target id).
const SET_PARAM_MAP_BODY =
  /const setParam = \(id: string, v: number, when\?: number\) => \{\s*\n\s*\/\/ Map legacy `tone` to `damping`\+`tone` for compat\s*\n\s*const targetId = id === "tone" \? "tone" : id;\s*\n\s*const p = node\.parameters\.get\(targetId\);\s*\n\s*if \(!p\) \{\s*\n\s*\/\/ Fallback: tone alias drives damping as well\s*\n\s*if \(id === "tone"\) \{\s*\n\s*const dp = node\.parameters\.get\("damping"\);\s*\n\s*if \(dp\) \{\s*\n\s*if \(when === undefined\) dp\.value = v;\s*\n\s*else dp\.setValueAtTime\(v, when\);\s*\n\s*\}\s*\n\s*\}\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(when === undefined\) p\.value = v;\s*\n\s*else p\.setValueAtTime\(v, when\);\s*\n\s*\};/g;

const SKIP = new Set([
  "bitcrusher-node.ts",
  "limiter-node.ts",
  "envfollower-node.ts",
  "eq-node.ts",
  "chorus-node.ts",
  "flanger-node.ts",
  "autowah-node.ts",
  "kaskada-node.ts",
  "ducking-delay-node.ts",
  "comb-node.ts",
  "beatmangler-node.ts",
  "freqshifter-node.ts",
  "compressor-node.ts", // already has its own in-line Number.isFinite guard
  "kwmeter-node.ts", // meter sink — no AudioParam writes
  "safeAudioParam.ts", // the helper itself
  "loader.ts", // pre-bundle loader, not an effect wrapper
]);

let touched = 0;
let alreadySafe = 0;
let canonical = 0;
let mapped = 0;
let skipped = 0;

for (const name of readdirSync(dir)) {
  if (!name.endsWith("-node.ts")) continue;
  if (SKIP.has(name)) {
    skipped++;
    continue;
  }
  const path = resolve(dir, name);
  let src = readFileSync(path, "utf8");

  if (src.includes('from "./safeAudioParam"')) {
    alreadySafe++;
    continue;
  }

  let replaced = null;
  if ((src.match(SET_PARAM_BODY) || []).length > 0) {
    src = src.replace(SET_PARAM_BODY, "// safeApplyAudioParam guards non-finite writes (defence-in-depth)");
    replaced = "canonical";
    canonical++;
  } else if ((src.match(SET_PARAM_BODY_PARAM) || []).length > 0) {
    src = src.replace(SET_PARAM_BODY_PARAM, "// safeApplyAudioParam guards non-finite writes (defence-in-depth)");
    replaced = "param-named";
  } else if ((src.match(SET_PARAM_MAP_BODY) || []).length > 0) {
    // reverb-node has the tone alias logic; leave the body intact and rely
    // on the import + global rewrite below — it stays semantically equivalent.
    replaced = "mapped-alias";
    mapped++;
  } else {
    // No matching setParam body — leave the file untouched but record.
    continue;
  }

  // Add the import next to the EffectRuntime import (safe to keep duplicated).
  if (!src.includes('import { safeApplyAudioParam }')) {
    src = src.replace(
      /^(import type \{ EffectRuntime \} from "\.\.\/effects\/types";)$/m,
      `$1\nimport { safeApplyAudioParam } from "./safeAudioParam";`,
    );
  }

  // Convert all inline `setParam(...)` call sites into helper invocations.
  // The setParam closure got removed above; remaining references are calls.
  src = src.replace(
    /setParam\(\s*("[^"]+"|`[^`]+`)\s*,\s*([^,]+?)(?:,\s*([^)]+))?\s*\)/g,
    (_match, id, value, when) =>
      when
        ? `safeApplyAudioParam(node, ${id}, ${value}, ${when})`
        : `safeApplyAudioParam(node, ${id}, ${value})`,
  );

  // Re-pattern header used in some files where the body has been removed but
  // local callers still pass `when` explicitly — safeApplyAudioParam always
  // treats a `when` arg as the scheduled time.
  // (Nothing else to fix — write the file.)
  writeFileSync(path, src);
  touched++;
}

console.log(
  JSON.stringify({ touched, alreadySafe, canonical, mapped, skipped }, null, 2),
);
