import { parseProductionIntent } from "./src/intent/production";
for (const t of [
  "pridaj phaser na lead",
  "viac sub na bas",
  "obrátený lead",
  "pridaj reverz na lead",
]) {
  const r = parseProductionIntent(t);
  console.log(JSON.stringify(t), "->", r ? JSON.stringify(r.goals.map(g=>g.concept)) : "null");
}
