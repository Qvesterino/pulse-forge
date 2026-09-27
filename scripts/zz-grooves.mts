import { GROOVE_LIBRARY } from "../src/ai/grooves/index";

const ids = [
  "house.disco",
  "house.funky",
  "house.broken",
  "house.indie",
  "house.altrock",
  "house.grunge",
  "ambient.pop",
  "ambient.organic",
  "ambient.drifting",
  "techno.hard",
  "techno.hardstyle",
  "dnb.amen",
  "boombap.jazz",
  "hybrid.lofimap",
  "house.heartbeat",
];
for (const id of ids) {
  const g = GROOVE_LIBRARY.find((x) => x.id === id);
  if (!g) {
    console.log(`MISSING ${id}`);
    continue;
  }
  const kick = g.patterns[0][2] ?? g.patterns[0][0] ?? [];
  const snare = g.patterns[0][5] ?? g.patterns[0][4] ?? [];
  console.log(
    `${g.id.padEnd(18)} bpm ${String(g.bpm).padEnd(12)} swing ${String(g.swing).padEnd(5)} pads ${g.activePads.join(",").padEnd(20)} pats ${g.patterns.length}`,
  );
  console.log(`    kick[0]: ${kick.join("")}  snare-ish[5]: ${snare.join("")}`);
}
