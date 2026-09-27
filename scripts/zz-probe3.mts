import { parseIntentText } from "../src/intent/text-parser";

for (const t of [
  "downtempo",
  "chill",
  "lo-fi",
  "lofi",
  "tempo",
  "study beats",
  "chillhop",
  "trip hop",
  "reggae",
  "ska",
  "boogie",
  "balearic",
  "gabber",
  "uptempo hardcore",
  "hardcore techno",
  "hardstyle",
  "synthwave",
  "shoegaze",
  "nu jazz",
  "breakcore",
  "dream pop",
]) {
  const p = parseIntentText(t);
  console.log(`${t.padEnd(18)} genre=${String(p.input.genre).padEnd(9)} style=${String(p.input.style)}`);
}
