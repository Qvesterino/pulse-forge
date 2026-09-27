import { parseIntentText } from "../src/intent/text-parser";
import { getGrooveById } from "../src/ai/grooves/index";

const probes = [
  "trip hop", "downtempo", "reggae", "ska", "one drop",
  "gabber", "hardcore techno", "happy hardcore", "uptempo hardcore",
  "shoegaze", "dream pop", "post rock",
  "brostep", "bass dubstep", "tearout dubstep",
  "hardstyle", "hardcore", "hardcore punk",
  "synthwave night drive", "chillhop", "nu jazz", "boogie", "balearic", "breakcore",
];
let bad = 0;
for (const text of probes) {
  const p = parseIntentText(text);
  const g = p.input.genre;
  const s = p.input.style;
  const sl = typeof s === "string" ? s.toLowerCase().replace(/\s+/g, "") : undefined;
  const resolved = g && sl ? getGrooveById(`${g}.${sl}`) : undefined;
  const dangling = g && sl && !resolved;
  if (dangling) bad++;
  console.log(`${text.padEnd(22)} genre=${String(g).padEnd(9)} style=${String(s).padEnd(11)} groove=${resolved ? resolved.id : dangling ? "*** DANGLING ***" : "(none)"}`);
}
console.log(bad === 0 ? "\nALL RESOLVE" : `\n${bad} DANGLING`);
