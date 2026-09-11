/**
 * Golden preferences template generator (goal doc Fáze 2 — human review).
 *
 * Emits scripts/data/intent-ranker-golden.json: ONE representative group per
 * main genre/style combination, candidates pre-filled in the heuristic
 * order and marked `reviewed: false`. The human curator reorders the ids
 * (best → worst) per group, sets `reviewed: true` and adds an optional
 * note — the trainer then treats golden orders as ground-truth labels.
 *
 * Run: npx vite-node scripts/generate-intent-ranker-golden.mts
 * (Existing reviewed golden files are NEVER overwritten.)
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";

const datasetPath = path.resolve("scripts", "data", "intent-ranker-dataset.json");
const goldenPath = path.resolve("scripts", "data", "intent-ranker-golden.json");

if (existsSync(goldenPath)) {
  const existing = JSON.parse(readFileSync(goldenPath, "utf8"));
  if (existing.reviewed) {
    console.log("[golden] reviewed golden file already exists — NOT overwriting. Delete it to regenerate.");
    process.exit(0);
  }
  console.log("[golden] unreviewed template exists — regenerating (review state resets).");
}

const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));

// One representative (first) group per genre:style combination.
const byCombo = new Map<string, (typeof dataset.groups)[number]>();
for (const group of dataset.groups) {
  const combo = `${group.genre}:${group.style ?? "-"}`;
  if (!byCombo.has(combo)) byCombo.set(combo, group);
}

const combos = [...byCombo.entries()].map(([combo, group]) => {
  // Heuristic order prefill: candidate indices sorted by heuristic score.
  const ordered = [...group.candidates]
    .sort((a, b) => b.heuristicScore - a.heuristicScore || a.index - b.index)
    .map((candidate) => candidate.index);
  return {
    combo,
    groupKey: group.groupKey,
    // Candidate indices in "best → worst" order. REORDER THESE by ear/judgment.
    order: ordered,
    candidateSeeds: group.candidates.map((candidate) => `#${candidate.index} (${candidate.seed})`),
  };
});

const golden = {
  version: "golden.v1",
  // Set to true ONLY after a human has reviewed every combo below.
  reviewed: false,
  reviewedBy: null,
  reviewedAt: null,
  /** How to review (see also public docs / goal doc Fáze 2):
   *  1. Per combo, reorder `order` so candidate indices go best → worst.
   *  2. Optionally add a free-form note.
   *  3. Set top-level `reviewed: true`, `reviewedBy`, `reviewedAt`.
   *  4. Re-train: npm run ranker:train (golden groups then use the golden
   *     order as ground-truth labels; the report gains a golden accuracy).
   */
  instructions: "Reorder `order` (candidate indices, best first) per combo. Set reviewed:true when done.",
  combos,
};

mkdirSync(path.dirname(goldenPath), { recursive: true });
writeFileSync(goldenPath, JSON.stringify(golden, null, 2));
console.log(`[golden] ${combos.length} combo template(s) → ${goldenPath} (reviewed=false)`);
