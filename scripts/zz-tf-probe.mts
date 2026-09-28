import { parseIntentText } from "../src/intent/text-parser";
for (const t of ["90s eurodance", "eurodance", "euro house 140", "hands up dance", "chip ballad town theme", "town theme", "boss battle theme", "nintendo overworld theme", "game boy lsdj", "cumbia sonidera", "merengue tipico", "bachata romantica", "salsa dura", "mambo big band", "bossa nova guitar", "italo dance", "happy eurodance", "german dance hands up", "euro trance dance", "chiptune", "8-bit game music", "game boy chip", "latin pop", "corridos tumbados"]) {
  const p = parseIntentText(t);
  console.log(`${t.padEnd(26)} genre=${String(p.input.genre).padEnd(10)} style=${p.input.style}`);
}
