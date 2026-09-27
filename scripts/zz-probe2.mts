import { parseIntentText } from "../src/intent/text-parser";
import { getGrooveById } from "../src/ai/grooves/index";

const probes = [
  "reggae",
  "reggae dub",
  "dancehall",
  "dancehall beat",
  "dub",
  "ragga",
  "ska",
  "riddim",
  "synthwave",
  "outrun",
  "darksynth",
  "hardstyle",
  "gabber",
  "happy hardcore",
  "breakcore",
  "chillhop",
  "post rock",
  "shoegaze",
  "dream pop",
  "nu jazz",
  "boogie",
  "balearic",
  "funk",
  "future garage",
  "hardcore",
];

for (const text of probes) {
  const p = parseIntentText(text);
  const g = p.input.genre;
  const s = p.input.style;
  const styleLower = typeof s === "string" ? s.toLowerCase().replace(/\s+/g, "") : undefined;
  const resolved = g && styleLower ? getGrooveById(`${g}.${styleLower}`) : undefined;
  console.log(
    `${text.padEnd(16)} genre=${String(g).padEnd(8)} style=${String(s).padEnd(14)} groove=${resolved ? resolved.id : "(random fallback)"}`,
  );
}
