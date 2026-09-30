import { routeIntentText } from "../src/intent/route";
import { datasetDoc } from "./intent-sft-doc.mts";
const doc = datasetDoc();
for (const q of ["more reverb on the hats", "more delay on the hats", "less reverb in the mix", "more reverb on the perc"]) {
  const r = routeIntentText(q, doc);
  console.log(JSON.stringify(q).padEnd(30), "→", JSON.stringify(r).slice(0, 110));
}
