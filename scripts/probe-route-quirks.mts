import { routeIntentText } from "../src/intent/route";
import { datasetDoc } from "./intent-sft-doc.mts";
const doc = datasetDoc();
for (const q of ["dial that bass back a notch", "ease the bass down a touch", "tame the drums a touch"]) {
  console.log(JSON.stringify(q), "→", routeIntentText(q, doc).kind);
}
