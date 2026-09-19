/**
 * Favorites pack → weighted training samples → retrain the drum prior
 * (INTENT_ENGINE.md T2 v2 feedback loop).
 *
 * Usage: npm run prior:favorites -- <favorites-pack.json>
 * (the pack is what the dice tray "⬇ ★" button downloads)
 *
 * 1. Reads the exported favorites pack (ledger entries with intent + rows).
 * 2. Converts them into weighted prior-features.v1 samples via the SHARED
 *    converter (src/intent/favorites.ts) — no layout drift possible.
 * 3. Spawns `train-symbolic-prior.py --favorites <samples>` which folds the
 *    weighted samples into the TRAIN split only and retrains the model.
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { favoritesToDrumSamples, type FavoritesPack } from "../src/intent/favorites";

const packPath = process.argv[2];
if (!packPath) {
  console.error("[favorites] usage: npm run prior:favorites -- <favorites-pack.json>");
  process.exit(1);
}

const pack = JSON.parse(readFileSync(path.resolve(packPath), "utf8")) as FavoritesPack;
if (pack.version !== 1 || !Array.isArray(pack.entries)) {
  throw new Error("unexpected favorites pack shape");
}

const samples = favoritesToDrumSamples(pack.entries);
if (samples.length === 0) {
  console.error("[favorites] pack produced no usable samples (unknown grooveIds or empty rows) — nothing to train on");
  process.exit(1);
}

const outDir = path.join(process.cwd(), "scripts", "data");
mkdirSync(outDir, { recursive: true });
const samplesPath = path.join(outDir, "symbolic-prior-favorites-samples.json");
writeFileSync(
  samplesPath,
  JSON.stringify(
    {
      datasetVersion: "symbolic-prior-favorites.v1",
      featureVersion: "prior-features.v1",
      sourceEntries: pack.entries.length,
      samples: samples.length,
      data: samples,
    },
    null,
    0,
  ),
);
console.log(`[favorites] ${pack.entries.length} entries → ${samples.length} weighted samples → ${samplesPath}`);

const result = spawnSync("python", ["scripts/train-symbolic-prior.py", "--favorites", samplesPath], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
