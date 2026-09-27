import { parseIntentText } from "../src/intent/text-parser";
import { matchArtistPreset } from "../src/intent/artists";

for (const t of [
  "synthwave",
  "synthwave night drive",
  "outrun",
  "darksynth",
  "kavinsky type beat",
  "hardstyle",
  "headhunterz type beat",
  "gabber",
  "hardcore techno",
  "happy hardcore",
  "uptempo hardcore",
  "hardcore",
  "hardcore punk",
  "reggae",
  "ska",
  "chillhop",
  "chillhop study beats",
  "trip hop",
  "boogie",
  "balearic",
  "shoegaze",
  "dream pop",
  "nu jazz",
  "post rock",
  "breakcore",
  "breakcore at 180",
]) {
  const p = parseIntentText(t);
  const m = matchArtistPreset(` ${t.toLowerCase()} `);
  console.log(
    `${t.padEnd(22)} genre=${String(p.input.genre).padEnd(9)} style=${String(p.input.style).padEnd(12)} artist=${m ? m.preset.label : "-"}`,
  );
}
