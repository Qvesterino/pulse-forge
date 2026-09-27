import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import { ARTIST_PRESETS } from "../src/intent/artists";

const byFam: Record<string, string[]> = {};
for (const g of GROOVE_LIBRARY) {
  const fam = g.id.split(".")[0];
  (byFam[fam] ??= []).push(g.id);
}
for (const [f, ids] of Object.entries(byFam)) {
  console.log(`${f} (${ids.length}): ${ids.join(", ")}`);
}
console.log("\nTOTAL grooves:", GROOVE_LIBRARY.length, "artists:", ARTIST_PRESETS.length);
