/**
 * Regenerates scripts/data/intent-ranker-golden.json as a fresh UNREVIEWED
 * template bound to the CURRENT dataset's exact group keys (the old review
 * referenced groups that no longer exist after the dataset regeneration).
 *
 * Picks 7 combos spread across the genre×style space, order = heuristic
 * (candidates sorted by heuristicScore desc) as the starting point.
 *
 * Run: npx vite-node scripts/generate-golden-template.mts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(
  (await import("node:fs")).readFileSync(path.join(ROOT, "scripts", "data", "intent-ranker-dataset.json"), "utf8"),
);

// groupKey → { prefix, heuristicScore sum, candidateCount }
const byPrefix = new Map<string, { groupKey: string; score: number; count: number }>();
for (const group of dataset.groups) {
  const prefix = group.groupKey.split(":").slice(0, 2).join(":");
  const existing = byPrefix.get(prefix);
  if (!existing) {
    byPrefix.set(prefix, { groupKey: group.groupKey, score: 0, count: 0 });
  }
}

const prefixes = [...byPrefix.keys()].sort();
// Spread: one combo per genre first (house/techno/trap/ambient), then fill
// round-robin preferring drum-heavy genres (ambient style variety is lower).
// Deterministic — alphabetical within each genre.
const byGenre = new Map<string, string[]>();
for (const prefix of prefixes) {
  const genre = prefix.split(":")[0];
  const list = byGenre.get(genre) ?? [];
  list.push(prefix);
  byGenre.set(genre, list);
}
const genreCycle = ["house", "techno", "trap", "ambient"].filter((genre) => (byGenre.get(genre) ?? []).length > 0);
const picked: string[] = [];
const perGenre = new Map<string, number>();
for (let round = 0; picked.length < 7 && round < 8; round++) {
  for (const genre of genreCycle) {
    if (picked.length >= 7) break;
    if (genre === "ambient" && round > 0) continue;
    const list = byGenre.get(genre)!;
    const at = perGenre.get(genre) ?? 0;
    if (at < list.length) {
      picked.push(list[at]);
      perGenre.set(genre, at + 1);
    }
  }
}

const groupsByPrefix = new Map<string, typeof dataset.groups>();
for (const group of dataset.groups) {
  const prefix = group.groupKey.split(":").slice(0, 2).join(":");
  const list = groupsByPrefix.get(prefix) ?? [];
  list.push(group);
  groupsByPrefix.set(prefix, list);
}

const combos = picked.map((prefix) => {
  const representative = groupsByPrefix.get(prefix)![0];
  const ordered = [...representative.candidates].sort((a, b) => b.heuristicScore - a.heuristicScore);
  return {
    combo: prefix,
    groupKey: representative.groupKey,
    order: ordered.map((candidate) => candidate.index),
  };
});

const template = {
  reviewed: false,
  reviewedBy: "",
  reviewedAt: "",
  datasetVersion: dataset.datasetVersion,
  note: "Poradie kandidátov (indexov) pre každý combo — najlepší PRVÝ. Pack: public/golden-review/",
  combos,
};

writeFileSync(path.join(ROOT, "scripts", "data", "intent-ranker-golden.json"), JSON.stringify(template, null, 2) + "\n");
console.log(`[golden-template] ${combos.length} combos (reviewed: false) → scripts/data/intent-ranker-golden.json`);
