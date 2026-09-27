import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import { readFileSync } from "node:fs";

const emb = JSON.parse(readFileSync("scripts/data/style-embeddings.json", "utf8"));
const embStyles: string[] = Array.isArray(emb) ? emb.map((e: { style: string }) => e.style) : Object.keys(emb.styles ?? emb);
const embSet = new Set(embStyles);
const grooveIds = GROOVE_LIBRARY.map((g) => g.id);

const missing = grooveIds.filter((id) => !embSet.has(id));
console.log("GROOVES WITHOUT STYLE EMBEDDING:", missing.length);
for (const id of missing) console.log("  " + id);

const orphanEmb = embStyles.filter((s) => !grooveIds.includes(s));
console.log("\nEMBEDDINGS WITHOUT GROOVE:", orphanEmb.length, orphanEmb.join(", ") || "(none)");

const wanted = [
  "trap.dubstep",
  "trap.deepdubstep",
  "drill.grime",
  "techno.trance",
  "techno.psytrance",
  "techno.hardstyle",
  "ambient.synthwave",
  "dnb.jungle",
  "house.gqom",
  "house.kuduro",
  "house.amapiano",
  "trap.dancehall",
  "trap.bounce",
  "trap.miamibass",
  "house.slaphouse",
  "house.bigbeat",
  "house.breakbeat",
  "trap.countrytune",
  "house.afroswing",
  "house.afrobeats",
  "house.reggaeton",
  "house.dembow",
  "house.kpop",
  "house.baile",
  "house.futurebass",
  "ambient.citypop",
  "hyperpop.decon",
  "techno.ebm",
  "house.melodic",
  "trap.bedroom",
  "trap.trapsoul",
  "trap.headnod",
  "trap.gfunk",
  "trap.corridos",
  "house.pianohouse",
  "house.midtempo",
  "ambient.sadchill",
  "ambient.dirtyambient",
];
console.log("\nREFERENCE BPM (id — genre — bpm — swing — pads):");
for (const id of wanted) {
  const g = GROOVE_LIBRARY.find((x) => x.id === id);
  if (!g) console.log(`  MISSING GROOVE ${id}`);
  else console.log(`  ${g.id} — ${g.genre} — ${g.bpm[0]}-${g.bpm[1]} — swing ${g.swing} — ${g.activePads.length} pads`);
}
