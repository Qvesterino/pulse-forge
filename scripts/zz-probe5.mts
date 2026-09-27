import { parseIntentText } from "../src/intent/text-parser";
import { getGrooveById } from "../src/ai/grooves/index";

const probes = [
  "chillhop",
  "chillhop study beats",
  "lofi hip hop",
  "lo-fi hip hop",
  "study beats",
  "trip hop",
  "triphop",
  "downtempo",
  "bonobo type beat",
  "reggae",
  "ska",
  "boogie",
  "balearic",
  "shoegaze",
  "dream pop",
  "nu jazz",
  "post rock",
  "breakcore",
  "gabber",
  "hardcore techno",
  "happy hardcore",
  "uptempo hardcore",
  "hardstyle",
  "synthwave night drive",
  "synthwave",
  "darksynth",
  "outrun",
];

for (const text of probes) {
  const p = parseIntentText(text);
  const g = p.input.genre;
  const s = p.input.style;
  const styleLower = typeof s === "string" ? s.toLowerCase().replace(/\s+/g, "") : undefined;
  const resolved = g && styleLower ? getGrooveById(`${g}.${styleLower}`) : undefined;
  const dangling = g && styleLower && !resolved;
  console.log(
    `${text.padEnd(22)} genre=${String(g).padEnd(9)} style=${String(s).padEnd(12)} groove=${resolved ? resolved.id : dangling ? "*** DANGLING ***" : "(no style)"}`,
  );
}
