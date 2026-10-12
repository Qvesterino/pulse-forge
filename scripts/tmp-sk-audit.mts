// SK vocabulary audit probe (F-campaign, vocabulary wave 9): run real Slovak
// producer phrases through the router and report expectation mismatches.
import { routeIntentText } from "../src/intent/route";
import { parseIntentText } from "../src/intent/text-parser";
import { testDoc } from "../tests/fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

const sceneDoc: ProjectDocument = {
  ...testDoc(),
  scenes: [
    { id: "s1", name: "Intro", patternId: "p1", role: "intro", intensity: 0.4 },
    { id: "s2", name: "Drop", patternId: "p2", role: "drop", intensity: 1 },
    { id: "s3", name: "Break", patternId: "p3", role: "break", intensity: 0.3 },
  ],
} as unknown as ProjectDocument;

const doc = testDoc();

interface Probe {
  text: string;
  expect: string;
  scenes?: boolean;
}

const PROBES: Probe[] = [
  // transport / save / undo
  { text: "spusti", expect: "transport" },
  { text: "zastav", expect: "transport" },
  { text: "stopni", expect: "transport" },
  { text: "uloz", expect: "save" },
  { text: "krok spat", expect: "undoIntent" },
  // tempo
  { text: "spomal to", expect: "tempo" },
  { text: "zrychli", expect: "tempo" },
  { text: "tempo dole", expect: "tempo" },
  { text: "tempo hore", expect: "tempo" },
  // fader
  { text: "stis lead", expect: "fader" },
  { text: "daj bicie hlasnejsie", expect: "fader" },
  { text: "kick hore", expect: "fader" },
  { text: "808 dole", expect: "fader" },
  // exact
  { text: "mutni lead", expect: "exact" },
  { text: "zapni basu", expect: "exact" },
  { text: "panuj lead dolava 30", expect: "exact" },
  { text: "posun basu o oktavu nizsie", expect: "exact" },
  // mix
  { text: "viac kompresie", expect: "mix" },
  { text: "suchsi mix", expect: "mix" },
  { text: "svetlejsi zvuk", expect: "mix" },
  // loudness
  { text: "celkovo tichsie", expect: "loudness" },
  { text: "urob to hlasnejsie", expect: "loudness" },
  // effect
  { text: "pridaj delay na lead", expect: "effectIntent" },
  { text: "odober reverb z basu", expect: "effectIntent" },
  { text: "menej saturacie na bicich", expect: "effectIntent" },
  // production
  { text: "sprav basu hlbsiu", expect: "production" },
  { text: "bubny tazsie", expect: "production" },
  { text: "hatsy jasnejsie", expect: "production" },
  // revise
  { text: "energetickejsie", expect: "revise" },
  { text: "hustejsie", expect: "revise" },
  { text: "pokojnejsie", expect: "revise" },
  // query
  { text: "ake je tempo", expect: "queryIntent" },
  { text: "aky je kluc", expect: "queryIntent" },
  // arrange
  { text: "presun intro na koniec", expect: "arrange", scenes: true },
  { text: "vymaz break", expect: "arrange", scenes: true },
  // complaints
  { text: "drop posobi prazdno", expect: "complaintIntent" },
  { text: "bicie su slabe", expect: "complaintIntent" },
  { text: "bicie su blatiste", expect: "complaintIntent" },
  { text: "lead krici", expect: "complaintIntent" },
  { text: "kick je mrtvy", expect: "complaintIntent" },
  { text: "bicie su dute", expect: "complaintIntent" },
  { text: "nic sa nedeje v drope", expect: "complaintIntent" },
  // moods (spot-check)
  { text: "smutne techno", expect: "pattern" },
  { text: "hypnoticky house", expect: "pattern" },
];

let gaps = 0;
for (const probe of PROBES) {
  const target = probe.scenes ? sceneDoc : doc;
  const route = routeIntentText(probe.text, target);
  const ok = route.kind === probe.expect;
  if (!ok) {
    gaps += 1;
    const moodNote = parseIntentText(probe.text).input.mood ?? "-";
    console.log(
      `GAP  "${probe.text}"  expect=${probe.expect}  got=${route.kind}` + (route.kind === "pattern" ? `  (mood=${moodNote})` : ""),
    );
  } else {
    console.log(`ok   "${probe.text}" → ${route.kind}`);
  }
}
console.log(`\n${gaps} gaps / ${PROBES.length} probes`);
