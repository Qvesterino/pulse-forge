/**
 * Evidence that the seeded groove pick no longer depends on library SIZE.
 * Compares the old index-based selection against the new rendezvous selection
 * over 400 seeds, under a simulated "one groove added to the genre" edit.
 */
import { hashString } from "./src/shared/rng";
import { getGroovesForGenre } from "./src/ai/grooves/index";
import { resolveGrooveSeeded } from "./src/ai/generator";
import type { GrooveData } from "./src/ai/types";

const genre = "house";
const real = getGroovesForGenre(genre);
const fake: GrooveData = {
  id: "house.zzz-new-lane",
  genre: "house",
  name: "Zzz New Lane",
  bpm: [128, 128],
  swing: 0.04,
  activePads: [0, 8],
  patterns: [{}],
} as unknown as GrooveData;

// Simulate the library AFTER the edit: one groove appended.
const grown = [...real, fake];

function oldPick(list: readonly GrooveData[], seed: string): string {
  // What `Math.floor(rand() * list.length)` did, with the same FNV stream the
  // production path used (`forkRandom(`${genre}|${seed}`, "groove")`).
  const r = ((() => {
    let h = 2166136261;
    const s = `${genre}|${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
  }) as () => number);
  return list[Math.floor(r() * list.length)].id;
}

function newPick(list: readonly GrooveData[], seed: string): string {
  // Mirror of pickGrooveBySeed, evaluated against an arbitrary list.
  let best = list[0];
  let bestWeight = -1;
  for (const g of list) {
    const w = hashString(`${genre}|${seed}|${g.id}`);
    if (w > bestWeight || (w === bestWeight && g.id < best.id)) {
      bestWeight = w;
      best = g;
    }
  }
  return best.id;
}

const SEEDS = 400;
let oldChanged = 0;
let newChanged = 0;
let newToNewGroove = 0;
for (let i = 0; i < SEEDS; i++) {
  const seed = `seed-${i}`;
  if (oldPick(real, seed) !== oldPick(grown, seed)) oldChanged++;
  const before = newPick(real, seed);
  const after = newPick(grown, seed);
  if (before !== after) {
    newChanged++;
    if (after === fake.id) newToNewGroove++;
  }
}

console.log(`genre=${genre}  grooves ${real.length} -> ${grown.length}  (one added)`);
console.log(`seeds tested: ${SEEDS}`);
console.log(`OLD (index-based)  picks that changed: ${oldChanged}  (${((oldChanged / SEEDS) * 100).toFixed(1)}%)`);
console.log(`NEW (rendezvous)   picks that changed: ${newChanged}  (${((newChanged / SEEDS) * 100).toFixed(1)}%)`);
console.log(`   of which the new groove won:        ${newToNewGroove}`);
console.log();

// Order-independence: reversing the library must not change anything.
let orderChanged = 0;
const reversed = [...real].reverse();
for (let i = 0; i < SEEDS; i++) {
  const seed = `seed-${i}`;
  if (newPick(real, seed) !== newPick(reversed, seed)) orderChanged++;
}
console.log(`order-independence: picks changed by reversing the array: ${orderChanged}/${SEEDS} (want 0)`);

// Public API still returns a real groove.
console.log(`resolveGrooveSeeded("house", undefined, "my-project-seed") =`, resolveGrooveSeeded("house", undefined, "my-project-seed").id);
console.log(`resolveGrooveSeeded("house", "ukg", "anything") =`, resolveGrooveSeeded("house", "ukg", "anything").id);
