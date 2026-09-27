/**
 * Does adding one groove to the library change which groove a fixed seed picks?
 * ADR 0004 invariant #4: "Same seed + intent + project → same content".
 */
import { forkRandom, hashString } from "./src/shared/rng";
import { resolveGroove } from "./src/ai/generator";
import { GROOVE_LIBRARY, getGroovesForGenre } from "./src/ai/grooves/index";

console.log("house grooves in library:", getGroovesForGenre("house").length);
console.log("total library:", GROOVE_LIBRARY.length);
console.log();

const seed = "my-project-seed";

// Current behaviour: index into the live array.
for (const genre of ["house", "trap", "techno"] as const) {
  const grooves = getGroovesForGenre(genre);
  const rand = forkRandom(`${genre}|${seed}`, "groove");
  const idx = Math.floor(rand() * grooves.length);
  const picked = resolveGroove(genre, undefined, forkRandom(`${genre}|${seed}`, "groove"));
  console.log(`${genre.padEnd(7)} len=${String(grooves.length).padStart(3)} idx=${String(idx).padStart(3)} -> ${picked.id}`);
}

console.log();
console.log("--- simulate the library growing by one groove (prepended) ---");

// What the index-based pick would become if one groove were inserted at the
// front of the genre's array (a plausible edit: a new "house" lane added).
for (const genre of ["house", "trap", "techno"] as const) {
  const before = resolveGroove(genre, undefined, forkRandom(`${genre}|${seed}`, "groove")).id;
  const withExtra = forkRandom(`${genre}|${seed}|EXTRA`, "groove")(); // unrelated, just to show rand is stable
  void withExtra;
  // Simulate: same rand stream, but one more element in the array.
  const rand = forkRandom(`${genre}|${seed}`, "groove");
  const r = rand();
  const lenBefore = getGroovesForGenre(genre).length;
  const idxBefore = Math.floor(r * lenBefore);
  const idxAfter = Math.floor(r * (lenBefore + 1));
  const list = getGroovesForGenre(genre);
  const after = idxAfter >= list.length ? list[idxAfter % list.length].id : (list[idxAfter] ?? list[0]).id;
  console.log(
    `${genre.padEnd(7)} r=${r.toFixed(6)}  idx ${idxBefore} -> ${idxAfter}   ${list[idxBefore]?.id} -> ${after}`,
  );
}
