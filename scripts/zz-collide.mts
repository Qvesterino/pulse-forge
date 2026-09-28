import { readFileSync } from "node:fs";
const src = (readFileSync("src/intent/artists.ts","utf8") + readFileSync("src/intent/text-parser.ts","utf8") + readFileSync("src/intent/semantic.ts","utf8")).toLowerCase();
const names = [
  // chiptune / vgm
  "anzu", "4mat", "jeroen tel", "rob hubbard", "tim follin", "grant kirkhope", "koji kondo", "nobuo uematsu", "yuzo koshiro", "c418", "lena raine", "disasterpeace", "chipzel", "sabrepulse", "dan terminus",
  // eurodance
  "ace of base", "scatman", "snap!", "eiffel 65", "vengaboys", "alice deejay", "cascada", "sash!", "la bouche", "2 unlimited", "corona", "hadaway", "culture beat", "real mccoy", "masterboy", "cappella", "tommie sunshine", "dj bobo", "brooklyn bounce", "scooter", "atb", "gigi dagostino", "molella", "prezioso",
  // latin
  "cumbia", "cumbias", "selena", "los angeles azules", "los aterciopelados", "bomba est", "merengue", "juan luis guerra", "bachata", "romeo santos", "avenura", "prince royce", "salsa", "celia cruz", "hector lavoe", "marc anthony", "grupo niche", "mambo", "tito puente", "bossa nova", "joao gilberto", "stan getz", "sergio mendes", "cumbia sonidera",
  "kumbia kings", "el gran combo", "la sonora", "shakira", "carlos vives", "maluma", "camilo",
];
const missing = names.filter((n) => !src.includes(n));
const present = names.filter((n) => src.includes(n));
console.log("PRESENT (" + present.length + "):", present.join(", "));
console.log("\nMISSING (" + missing.length + "):", missing.join(", "));
