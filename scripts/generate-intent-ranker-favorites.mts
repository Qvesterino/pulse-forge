/**
 * Favorites pack → intent-ranker preference groups (INTENT_ENGINE.md C2).
 *
 * A favourite is a PAIRWISE PREFERENCE: the roll the user kept is better than
 * what the same intent would otherwise offer. This script reconstructs that
 * comparison deterministically — for every ledger entry it rebuilds the exact
 * intent (all controls are recorded) and generates the favourite's pattern
 * PLUS same-intent sibling rolls (derived seeds); the favourite is labeled
 * the group winner.
 *
 * Output uses the intent-ranker dataset schema (groups with candidates that
 * carry features.v1 vectors + heuristic scores), so
 * `train-intent-ranker.py --favorites` folds it in without any format
 * bridging: the favourite's label becomes 1.0 in the trainer, negatives keep
 * their heuristic scores, favorite groups are TRAIN-only and oversampled.
 *
 * Run (via npm run favorites:retrain): vite-node scripts/generate-intent-ranker-favorites.mts <pack.json>
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFavoriteRankerGroups, type RankerFavoriteGroups } from "../src/intent/ranker-favorites";
import type { FavoritesPack } from "../src/intent/favorites";

export type { RankerFavoriteGroups };
export { buildFavoriteRankerGroups };

// CLI entry — also invoked by scripts/export-favorites-training.mts via the
// exported builder (same process, no nested vite-node spawn).
const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const packPath = process.argv[2];
  if (!packPath) {
    console.error("[ranker-favorites] usage: vite-node scripts/generate-intent-ranker-favorites.mts <pack.json>");
    process.exit(1);
  }
  const pack = JSON.parse(readFileSync(path.resolve(packPath), "utf8")) as FavoritesPack;
  if (pack.version !== 1 || !Array.isArray(pack.entries)) throw new Error("unexpected favorites pack shape");
  const built = buildFavoriteRankerGroups(pack);
  if (built.groups.length === 0) {
    console.error("[ranker-favorites] pack produced no usable preference groups — nothing to train on");
    process.exit(1);
  }
  const outDir = path.join(process.cwd(), "scripts", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "intent-ranker-favorites.json");
  writeFileSync(outPath, JSON.stringify(built, null, 0));
  console.log(
    `[ranker-favorites] ${built.sourceEntries} entries → ${built.groups} preference groups (${built.skippedEntries} skipped) → ${outPath}`,
  );
}
