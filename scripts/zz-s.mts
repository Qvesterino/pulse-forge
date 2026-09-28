import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import { ARTIST_PRESETS } from "../src/intent/artists";
const byFam: Record<string, number> = {};
for (const g of GROOVE_LIBRARY) { const f = g.genre; byFam[f] = (byFam[f] ?? 0) + 1; }
console.log("GROOVES BY GENRE:", Object.entries(byFam).sort((a,b)=>b[1]-a[1]).map(([g,n])=>`${g} ${n}`).join(" | "));
const byG: Record<string, number> = {};
for (const p of ARTIST_PRESETS) byG[p.genre] = (byG[p.genre] ?? 0) + 1;
console.log("ARTISTS BY GENRE:", Object.entries(byG).sort((a,b)=>b[1]-a[1]).map(([g,n])=>`${g} ${n}`).join(" | "));
console.log("TOTAL grooves:", GROOVE_LIBRARY.length, "artists:", ARTIST_PRESETS.length);
