import { parseProductionIntent } from "./src/intent/production";
for (const t of ["hustý sub na bas", "viac 808 na bas", "reverz lead", "obrátený bas", "spätný bas", "skútený lead"]) {
  const r = parseProductionIntent(t);
  console.log(JSON.stringify(t), "->", r ? JSON.stringify(r.goals.map(g=>g.concept)) : "null");
}
