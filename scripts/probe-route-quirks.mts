import { routeIntentText } from "../src/intent/route";
import { datasetDoc } from "./intent-sft-doc.mts";
const doc = datasetDoc();
const cases: Array<[string, string]> = [
  ["metronóm zapni", "transport"],
  ["metronom zapni", "transport"],
  ["metronome on", "transport"],
  ["štart", "transport"],
  ["hrať", "transport"],
  ["stop", "transport"],
  ["zastav", "transport"],
  ["please play", "transport"],
  ["play please", "transport"],
  ["prosim hraj", "transport"],
  ["loop vypni", "transport"],
  ["cyklus zapni", "transport"],
  ["zapni loop", "transport"],
  ["mute the drums", "exact"],
  ["play the beat", "pattern"],
  ["prestav nahrávanie", "record"],
];
let bad = 0;
for (const [q, want] of cases) {
  const r = routeIntentText(q, doc);
  if (r.kind !== want) {
    bad += 1;
    console.log("FAIL", r.kind.padEnd(11), "want", want.padEnd(11), q);
  }
}
console.log(bad === 0 ? `ALL ${cases.length} OK` : `${bad} FAILURES`);
