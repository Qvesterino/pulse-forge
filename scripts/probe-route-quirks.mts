/** Verify wave-2 templates route to their intended kinds. */
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import { datasetDoc } from "./intent-sft-doc.mts";

const doc = datasetDoc();
const cases: Array<[string, string]> = [
  ["double the intro", "arrange"],
  ["zdvojnásob intro", "arrange"],
  ["zdvojnásob drop", "arrange"],
  ["loudness na -10", "loudness"],
  ["-9 lufs", "loudness"],
  ["-16 lufs", "loudness"],
  ["loop vypni", "transport"],
  ["loop zapni", "transport"],
  ["please loop on", "transport"],
  ["cyklus zapni", "transport"],
  ["vypni cyklus", "transport"],
  ["prosim hraj", "transport"],
  ["please play", "transport"],
  ["play please", "transport"],
  ["please stop", "transport"],
  ["zapni loop", "transport"],
  ["cykluj vypni", "transport"],
  ["pann the lead left 20", "clarify"],
  ["soloo the drums", "clarify"],
  ["mut the bass", "clarify"],
  ["viac reverbu na bicie", "effectIntent"],
  ["menej reverbu na leade", "effectIntent"],
  ["viac delayu na basi", "effectIntent"],
  ["viac reverbu", "mix"],
  ["viac saturácie", "clarify"],
  ["pridaj kompresiu na trubky", "clarify"],
  ["viac reverbu na basi", "effectIntent"],
  ["menej reverbu v mixe", "mix"],
  ["viac reverbu v mixe", "mix"],
  ["less reverb in the mix", "mix"],
  ["hlbší kick", "production"],
  ["teplejší bas", "production"],
  ["jasnejšie bicie", "production"],
  ["obrovský dozvuk", "mix"],
  ["obri dozvuk", "mix"],
  ["zrýchli", "tempo"],
  ["rýchlejšie", "tempo"],
  ["tempo hore", "tempo"],
  ["zrýchli to", "tempo"],
  ["more reverb on the perc", "mix"],
  ["more reverb on the hats", "mix"],
  ["more delay on the hats", "clarify"],
];
let bad = 0;
for (const [q, want] of cases) {
  const r = compactIntentResponse(routeIntentText(q, doc));
  const ok = r.kind === want;
  if (!ok) {
    bad += 1;
    console.log("FAIL", r.kind.padEnd(13), "want", want.padEnd(11), q, JSON.stringify(r).slice(0, 90));
  }
}
console.log(bad === 0 ? `ALL ${cases.length} ROUTE OK` : `${bad} FAILURES of ${cases.length}`);
