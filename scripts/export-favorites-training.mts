/**
 * Favorites pack → retrain ALL THREE learned models (INTENT_ENGINE.md C1+C2):
 *
 * Usage: npm run favorites:retrain -- <favorites-pack.json>
 * (the pack is what the dice tray "⬇ ★" button downloads)
 *
 * 1. DRUM PRIOR — pack → weighted per-step samples (shared converter) →
 *    `train-symbolic-prior.py --favorites`.
 * 2. MELODIC PRIOR — pack → weighted next-note samples (pitch→degree through
 *    the recorded key) → `train-symbolic-melodic.py --favorites` (skipped
 *    when the pack carries no melodic content).
 * 3. RANKER — pack → preference groups (favorite = winner, same-intent
 *    siblings = alternatives, features.v1) →
 *    `train-intent-ranker.py --favorites`.
 *
 * Everything is computed through the SHARED TypeScript converters, so the
 * training data can never drift from the runtime feature contracts.
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  favoritesToDrumSamples,
  favoritesToMelodicSamples,
  type FavoritesPack,
} from "../src/intent/favorites";
import { buildFavoriteRankerGroups } from "./generate-intent-ranker-favorites.mts";

const packPath = process.argv[2];
if (!packPath) {
  console.error("[favorites] usage: npm run favorites:retrain -- <favorites-pack.json>");
  process.exit(1);
}

const pack = JSON.parse(readFileSync(path.resolve(packPath), "utf8")) as FavoritesPack;
if (pack.version !== 1 || !Array.isArray(pack.entries)) {
  throw new Error("unexpected favorites pack shape");
}

const outDir = path.join(process.cwd(), "scripts", "data");
mkdirSync(outDir, { recursive: true });

function runPython(script: string, args: string[]): boolean {
  const result = spawnSync("python", [script, ...args], { stdio: "inherit" });
  return result.status === 0;
}

// ── 1. Drum prior ───────────────────────────────────────────────────────────
const drumSamples = favoritesToDrumSamples(pack.entries);
if (drumSamples.length === 0) {
  console.error("[favorites] pack produced no usable drum samples (unknown grooveIds or empty rows)");
  process.exit(1);
}
const drumPath = path.join(outDir, "symbolic-prior-favorites-samples.json");
writeFileSync(
  drumPath,
  JSON.stringify(
    {
      datasetVersion: "symbolic-prior-favorites.v1",
      featureVersion: "prior-features.v1",
      sourceEntries: pack.entries.length,
      samples: drumSamples.length,
      data: drumSamples,
    },
    null,
    0,
  ),
);
console.log(`[favorites] drums: ${pack.entries.length} entries → ${drumSamples.length} weighted samples`);

if (!runPython("scripts/train-symbolic-prior.py", ["--favorites", drumPath])) {
  process.exit(1);
}

// ── 2. Melodic prior (C1) ───────────────────────────────────────────────────
const melodicSamples = favoritesToMelodicSamples(pack.entries);
if (melodicSamples.length > 0) {
  const melodicPath = path.join(outDir, "symbolic-melodic-favorites-samples.json");
  writeFileSync(
    melodicPath,
    JSON.stringify(
      {
        datasetVersion: "symbolic-melodic-favorites.v1",
        featureVersion: "melodic-features.v1",
        sourceEntries: pack.entries.length,
        samples: melodicSamples.length,
        data: melodicSamples,
      },
      null,
      0,
    ),
  );
  console.log(`[favorites] melodic: ${melodicSamples.length} weighted next-note samples`);
  if (!runPython("scripts/train-symbolic-melodic.py", ["--favorites", melodicPath])) {
    process.exit(1);
  }
} else {
  console.log("[favorites] melodic: pack carries no melodic content — melodic prior untouched");
}

// ── 3. Ranker (C2) — preference groups through the real pipeline ────────────
const built = buildFavoriteRankerGroups(pack);
if (built.groupCount === 0) {
  console.error("[favorites] ranker: pack produced no usable preference groups — ranker untouched");
  process.exit(1);
}
const groupsPath = path.join(outDir, "intent-ranker-favorites.json");
writeFileSync(groupsPath, JSON.stringify(built, null, 0));
console.log(`[favorites] ranker: ${built.groupCount} preference groups (${built.skippedEntries} skipped)`);
if (!runPython("scripts/train-intent-ranker.py", ["--favorites", groupsPath])) {
  process.exit(1);
}
console.log("[favorites] all three models retrained with your preferences ✔");
