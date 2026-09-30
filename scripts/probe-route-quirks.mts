/** Full routing verification: wrongKind wave + regressions. */
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import { datasetDoc } from "./intent-sft-doc.mts";

const doc = datasetDoc();
const cases: Array<[string, string]> = [
  ["add a chorus section", "arrange"], ["add a verse after the intro", "arrange"],
  ["wet it up", "mix"], ["make it drier", "mix"],
  ["sidechain on", "mix"], ["sidechain off", "mix"],
  ["less sidechain", "mix"], ["more pumping", "mix"],
  ["make the bass deeper", "production"], ["make the drums wider", "production"],
  ["make the chords brighter", "production"], ["make the lead warmer", "production"],
  ["load the warm preset on the chords", "preset"], ["load the bright preset on the chords", "preset"],
  ["set the chords to 75% and set tempo to 132", "compound"],
  ["solo the lead and set the bass to 40%", "compound"],
  ["mute the hats and set tempo to 140", "compound"],
  ["loudness to -16", "loudness"], ["loudness na -8", "loudness"], ["target -10 lufs", "loudness"],
  ["more delay", "clarify"],
  ["pridaj chorus send na bicie", "sendIntent"], ["pridaj reverb send na basu", "sendIntent"],
  ["pridaj chorus sekciu", "arrange"], ["pridaj verse za intro", "arrange"],
  ["mokrejší mix", "mix"], ["taký suchší mix", "mix"],
  ["sidechain zapni", "mix"], ["sidechain vypni", "mix"],
  ["sprav basu širšiu", "production"], ["sprav bicie hlbšie", "production"],
  ["sprav lead jasnejší", "production"], ["sprav akordy teplejšie", "production"],
  ["načítaj warm preset na leade", "preset"],
  ["hlasitosť na -8", "loudness"], ["hlasitosť na -10", "loudness"], ["viac delayu", "clarify"],
  ["add chorus send to the bass", "sendIntent"], ["add reverb send to the drums", "sendIntent"],
  ["add a break before the drop", "arrange"], ["duplicate the drop", "arrange"],
  ["dry it up", "mix"], ["more sidechain", "mix"], ["no pump", "mix"], ["bez pumpy", "mix"],
  ["sprav lead hlbšiu", "production"], ["hlbšie bicie", "production"],
  ["sprav bicie razantnejšie", "production"], ["sprav basu hlbšiu", "production"],
  ["loudness na -16", "loudness"], ["hlasnejšie bicie", "fader"],
  ["mute the drums and zníž basu", "compound"], ["more chorus on the lead", "effectIntent"],
  ["načítaj preset reese na leade", "preset"],
];
let bad = 0;
for (const [q, want] of cases) {
  const r = compactIntentResponse(routeIntentText(q, doc));
  const ok = r.kind === want;
  if (!ok) { bad += 1; console.log("FAIL", r.kind.padEnd(13), "want", want.padEnd(13), q, JSON.stringify(r).slice(0, 100)); }
}
console.log(bad === 0 ? `ALL ${cases.length} ROUTE OK` : `${bad} FAILURES of ${cases.length}`);
