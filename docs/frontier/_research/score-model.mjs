/**
 * AAW prioritisation model — reproducible scoring for the frontier program.
 *
 * Reproduces every weighted score and rank in AAW_ROADMAP_2026_2029.md §2.
 * Run:  node docs/frontier/_research/score-model.mjs
 *
 * Columns per row (1-5 each):
 *   id, userValue, musicalDifferentiation, technicalFeasibility, evidenceStrength,
 *   dataAvailability, latencyFeasibility, safety, maintainability, indieAffordability
 *
 * Weight sets: base + three alternative weightings used for the sensitivity analysis.
 */
const csv = `K-1,4,4,5,4,5,5,5,4,5
K-2,5,5,4,4,5,4,4,4,4
K-3,4,5,2,3,3,2,3,2,2
K-4,4,4,5,4,5,5,5,5,5
K-5,4,5,4,4,5,5,5,4,5
K-6,4,4,4,3,5,4,5,4,5
K-7,4,3,5,5,5,5,5,5,5
K-8,3,5,2,3,3,2,3,2,3
K-9,3,3,3,2,2,3,4,3,3
K-10,3,4,4,3,3,4,3,3,4
K-11,4,3,4,3,4,3,3,4,4
K-12,3,3,5,4,5,5,5,5,5
Z-1,5,4,5,5,5,5,5,5,5
Z-2,4,4,4,4,4,4,4,4,4
Z-3,4,4,5,4,5,5,4,5,5
Z-4,5,3,4,4,5,4,4,4,4
Z-5,3,3,3,3,2,3,4,3,3
Z-6,4,4,3,3,3,4,3,3,3
Z-7,3,3,4,3,3,4,4,3,4
Z-8,4,3,4,3,4,4,3,4,4
Z-9,2,3,3,2,3,3,2,3,3
Z-10,3,2,5,4,5,5,5,5,5
Z-11,5,3,5,5,5,5,5,4,5
Z-12,4,2,5,5,5,5,5,5,5
P-1,5,3,5,5,5,5,5,4,5
P-2,5,4,4,4,5,4,5,4,4
P-3,4,3,5,5,5,5,5,5,5
P-4,4,4,4,4,5,4,5,4,4
P-5,4,3,4,4,5,5,5,4,4
P-6,4,3,4,4,5,5,5,3,4
P-7,3,2,5,5,5,5,4,5,5
P-8,4,2,4,4,5,5,4,3,4
P-9,4,5,4,4,5,5,5,3,4
P-10,4,5,3,3,3,3,4,3,3
P-11,4,3,5,5,4,4,5,5,5
P-12,3,4,3,3,3,3,3,2,3`
  .trim()
  .split("\n")
  .map((l) => l.split(","));

const CRITERIA = [
  "userValue",
  "musicalDifferentiation",
  "technicalFeasibility",
  "evidenceStrength",
  "dataAvailability",
  "latencyFeasibility",
  "safety",
  "maintainability",
  "indieAffordability",
];

const WEIGHTS = {
  base: [0.16, 0.14, 0.13, 0.13, 0.09, 0.08, 0.1, 0.09, 0.08],
  "safety-first": [0.12, 0.1, 0.11, 0.11, 0.07, 0.06, 0.25, 0.1, 0.08],
  "evidence-first": [0.25, 0.1, 0.1, 0.25, 0.07, 0.06, 0.07, 0.05, 0.05],
  "ship-fast": [0.12, 0.05, 0.25, 0.07, 0.07, 0.1, 0.1, 0.14, 0.1],
};

for (const [name, w] of Object.entries(WEIGHTS)) {
  const sum = w.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`weights for ${name} sum to ${sum}`);
}

const rank = (w) =>
  csv
    .map((row) => {
      const id = row[0];
      const scores = row.slice(1).map(Number);
      if (scores.length !== CRITERIA.length) throw new Error(`row ${id} has ${scores.length} scores`);
      if (scores.some((s) => s < 1 || s > 5)) throw new Error(`row ${id} has a score outside 1..5`);
      const total = scores.reduce((acc, v, i) => acc + v * w[i], 0);
      return { id, total: Math.round(total * 1000) / 1000 };
    })
    .sort((a, b) => b.total - a.total);

const base = rank(WEIGHTS.base);
const rankOf = (weightName, id) => rank(WEIGHTS[weightName]).findIndex((x) => x.id === id) + 1;

console.log(
  "| id | base score | base rank | safety-first | evidence-first | ship-fast | rank delta (safety / evidence / ship) |",
);
console.log("|---|---|---|---|---|---|---|");
for (let i = 0; i < base.length; i++) {
  const { id, total } = base[i];
  const deltas = ["safety-first", "evidence-first", "ship-fast"].map((k) => {
    const d = rankOf(k, id) - (i + 1);
    return d > 0 ? `+${d}` : `${d}`;
  });
  console.log(
    `| ${id} | ${total.toFixed(2)} | ${i + 1} | ${rankOf("safety-first", id)} | ${rankOf("evidence-first", id)} | ${rankOf("ship-fast", id)} | ${deltas.join(" / ")} |`,
  );
}

console.log(
  "\nTOP 10 (base): " +
    base
      .slice(0, 10)
      .map((r) => `${r.id} (${r.total.toFixed(2)})`)
      .join(", "),
);
console.log(
  "MIDDLE: " +
    base
      .slice(10, 24)
      .map((r) => `${r.id} (${r.total.toFixed(2)})`)
      .join(", "),
);
console.log(
  "BOTTOM: " +
    base
      .slice(24)
      .map((r) => `${r.id} (${r.total.toFixed(2)})`)
      .join(", "),
);
