import { ARTIST_PRESETS } from "../src/intent/artists";
import { getGrooveById, getGroovesForGenre } from "../src/ai/grooves/index";

console.log("DANGLING ARTIST PRESETS (genre+style has NO groove → silent random fallback):");
let n = 0;
for (const p of ARTIST_PRESETS) {
  const style = p.style?.toLowerCase().replace(/\s+/g, "");
  if (!style) continue;
  if (!getGrooveById(`${p.genre}.${style}`)) {
    n++;
    const avail = getGroovesForGenre(p.genre).map((g) => g.id.split(".")[1]);
    console.log(`  ${p.genre}/${p.style.padEnd(16)} "${(p.label ?? p.names[0]).padEnd(24)}" avail: ${avail.join(",")}`);
  }
}
console.log("total dangling artist presets:", n, "/", ARTIST_PRESETS.length);
