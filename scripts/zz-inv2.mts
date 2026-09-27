import { ARTIST_PRESETS } from "../src/intent/artists";
import { readFileSync } from "node:fs";

const byGenre: Record<string, number> = {};
for (const p of ARTIST_PRESETS) byGenre[p.genre] = (byGenre[p.genre] ?? 0) + 1;
console.log("ARTIST PRESETS BY GENRE:");
for (const [g, n] of Object.entries(byGenre).sort((a, b) => b[1] - a[1])) console.log(`  ${g}: ${n}`);

const emb = JSON.parse(readFileSync("scripts/data/style-embeddings.json", "utf8"));
const styles: string[] = Array.isArray(emb) ? emb.map((e: { style: string }) => e.style) : Object.keys(emb.styles ?? emb);
console.log("\nSTYLE EMBEDDINGS:", styles.length);
console.log(styles.sort().join(", "));

const parser = readFileSync("src/intent/text-parser.ts", "utf8");
const probes = [
  "dubstep",
  "brostep",
  "riddim",
  "trip hop",
  "triphop",
  "downtempo",
  "reggae",
  "dub ",
  "soundsystem",
  "grime",
  "trance",
  "psytrance",
  "gabber",
  "hardcore techno",
  "uptempo",
  "synthwave",
  "darksynth",
  "shoegaze",
  "dream pop",
  "nu jazz",
  "broken beat",
  "funk",
  "boogie",
  "balearic",
  "jungle",
  "breakcore",
  "city pop",
  "k-pop",
  "phonk",
  "gqom",
  "kuduro",
  "baile",
  "corridos",
  "reggaeton",
  "dembow",
  "dancehall",
  "afrobeats",
  "amapiano",
  "lo-fi",
  "lofi",
  "drum and bass",
  "hyperpop",
  "jersey",
  "uk garage",
  "drill",
  "ambient",
  "techno",
  "house",
  "trap",
];
console.log("\nPARSER STYLE_PHRASES PROBES:");
for (const p of probes) {
  const hit = parser.includes(`"${p}"`) || parser.includes(`'${p}'`) || parser.includes(p);
  console.log(`  ${hit ? "OK  " : "MISS"} ${p}`);
}
