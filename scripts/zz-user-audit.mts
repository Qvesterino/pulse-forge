import { ARTIST_PRESETS } from "../src/intent/artists";
import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import { readFileSync } from "node:fs";

const t = readFileSync("src/intent/artists.ts", "utf8").toLowerCase();
const parser = readFileSync("src/intent/text-parser.ts", "utf8").toLowerCase();

const artists = ["overmono", "latin mafia", "duskus", "pluko", "flume", "pinkpantheress", "breakbeat"];
console.log("=== ARTISTS ===");
for (const a of artists) {
  const inRoster = ARTIST_PRESETS.some((p) => p.names.some((n) => n.includes(a)));
  const label = ARTIST_PRESETS.find((p) => p.names.some((n) => n.includes(a)))?.label ?? "-";
  console.log(`  ${inRoster ? "PRESENT" : "missing"}  ${a}${inRoster ? `  (${label})` : ""}`);
}

const styles = ["midtempo", "sad chill", "sadchill", "dirty ambient", "dirtyambient", "piano house", "pianohouse", "breakbeat", "breaks"];
console.log("\n=== STYLE PHRASES (parser) ===");
for (const s of styles) {
  console.log(`  ${parser.includes(`"${s}"`) ? "PRESENT" : "missing"}  ${s}`);
}

console.log("\n=== GROOVE IDS (exact) ===");
const ids = GROOVE_LIBRARY.map((g) => g.id);
for (const s of styles) {
  const hit = ids.filter((id) => id.includes(s.replace(/\s+/g, "")));
  console.log(`  ${hit.length > 0 ? "PRESENT" : "missing"}  ${s}${hit.length ? ` → ${hit.join(", ")}` : ""}`);
}

console.log("\n=== candidate grooves (by name) ===");
for (const g of GROOVE_LIBRARY) {
  if (/piano|midtempo|sad|dirty|break|broken|dubstep|future/i.test(g.id + " " + g.name)) {
    console.log(`  ${g.id} — ${g.name} (${g.bpm[0]}-${g.bpm[1]})`);
  }
}

console.log("\n=== related artists already mapped ===");
for (const label of ["flume", "duskus", "overmono", "pinkpantheress", "future bass", "illenium", "seven lions"]) {
  const p = ARTIST_PRESETS.find((x) => x.label.toLowerCase().includes(label));
  if (p) console.log(`  ${p.label}: genre=${p.genre} style=${p.style} bpm=${JSON.stringify(p.bpmRange)}`);
}
