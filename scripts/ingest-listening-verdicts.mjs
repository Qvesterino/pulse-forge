/**
 * Listening Room verdict → intent-engine training data (user request
 * 2026-09-21). Reads listening/verdicts.json (written by the room page via
 * the serve-listening API) and produces:
 *
 *   1. ranking verdicts  → MERGED into scripts/data/intent-ranker-golden.json
 *      (only when the groupKey exists in the ranker dataset — the room
 *      renders dataset-compatible groups, so matches are the norm;
 *      unmatched verdicts are reported and kept in the file untouched)
 *   2. favourite verdicts → listening/favorites-pack.json in the
 *      FavoritesPack shape → feed it to
 *      `npm run favorites:retrain -- listening/favorites-pack.json`
 *      which retrains ALL THREE learned models (drum prior, melodic
 *      prior, ranker) through the shared TS converters.
 *
 * The ingest only ever APPENDS training data — it never deletes or
 * overwrites existing golden orders from other sources.
 *
 * Run: npm run listening:ingest
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verdictsPath = path.join(ROOT, "listening", "verdicts.json");
const goldenPath = path.join(ROOT, "scripts", "data", "intent-ranker-golden.json");
const datasetPath = path.join(ROOT, "scripts", "data", "intent-ranker-dataset.json");
const favoritesPackPath = path.join(ROOT, "listening", "favorites-pack.json");

if (!existsSync(verdictsPath)) {
  console.error("[ingest] no verdicts yet — listen first (npm run listening:serve → /room/)");
  process.exit(1);
}
const verdicts = JSON.parse(readFileSync(verdictsPath, "utf8"));
if (!Array.isArray(verdicts) || verdicts.length === 0) {
  console.error("[ingest] verdicts.json is empty");
  process.exit(1);
}

const rankings = verdicts.filter((v) => v.kind === "ranking" && Array.isArray(v.order) && v.groupKey);
const favourites = verdicts.filter((v) => v.kind === "favorite" && v.entry && v.groupKey);

// ── 1) rankings → ranker golden ────────────────────────────────────────────
let matched = 0;
const unmatched = [];
if (rankings.length > 0) {
  const knownGroups = new Set();
  if (existsSync(datasetPath)) {
    const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
    for (const group of dataset.groups ?? []) knownGroups.add(group.groupKey);
  } else {
    console.warn("[ingest] ranker dataset not found — skipping membership check");
  }

  const golden = existsSync(goldenPath)
    ? JSON.parse(readFileSync(goldenPath, "utf8"))
    : { version: 1, combos: [] };
  if (!Array.isArray(golden.combos)) golden.combos = [];

  for (const verdict of rankings) {
    if (knownGroups.size > 0 && !knownGroups.has(verdict.groupKey)) {
      unmatched.push(verdict.groupKey);
      continue;
    }
    const existing = golden.combos.find((combo) => combo.groupKey === verdict.groupKey);
    const record = {
      groupKey: verdict.groupKey,
      order: verdict.order,
      reviewed: true,
      reviewedBy: "listening-room",
      reviewedAt: new Date(verdict.savedAt ?? Date.now()).toISOString(),
    };
    if (existing) {
      Object.assign(existing, record);
      existing.source = "listening-room";
    } else {
      golden.combos.push({ ...record, source: "listening-room" });
    }
    matched += 1;
  }
  if (matched > 0) {
    golden.updatedAt = new Date().toISOString();
    golden.updatedBy = "listening-room";
    writeFileSync(goldenPath, JSON.stringify(golden, null, 2));
  }
}

// ── 2) favourites → FavoritesPack ──────────────────────────────────────────
let packCount = 0;
if (favourites.length > 0) {
  const pack = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: "listening-room",
    entries: favourites.map((v) => ({ ...v.entry, savedAt: v.savedAt ?? Date.now() })),
  };
  writeFileSync(favoritesPackPath, JSON.stringify(pack, null, 2));
  packCount = pack.entries.length;
}

console.log(`[ingest] rankings: ${rankings.length} total → ${matched} merged into intent-ranker-golden.json`);
if (unmatched.length > 0) console.warn(`[ingest] unmatched groupKeys (not in dataset): ${[...new Set(unmatched)].join(", ")}`);
console.log(`[ingest] favourites: ${favourites.length} → listening/favorites-pack.json (${packCount} entries)`);
if (packCount > 0) {
  console.log("[ingest] retrain all three models with:");
  console.log("         npm run favorites:retrain -- listening/favorites-pack.json");
}
