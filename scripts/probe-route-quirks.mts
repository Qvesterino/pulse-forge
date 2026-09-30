/** Verify wave-3 templates + compound short-part alias. */
import { routeIntentText } from "../src/intent/route";
import { compactIntentResponse } from "../src/intent/dataset";
import { datasetDoc } from "./intent-sft-doc.mts";
import { setIntentModelProvider, tryModelRoute } from "../src/intent/model-resolver";

const doc = datasetDoc();
const cases: Array<[string, string]> = [
  ["pridaj reverb na trubky", "clarify"],
  ["menej delayu na trubky", "clarify"],
  ["tichšie", "loudness"],
  ["hlasnejšie v mixe", "clarify"],
  ["hlasnejšie", "clarify"],
  ["menej ozveny prosím", "mix"],
  ["menej dozvuku v mixe", "mix"],
  ["menej ozveny", "mix"],
  ["usporiadaj do songu", "arrange"],
  ["usporiadaj pesničku", "arrange"],
  ["usporiadaj do pesničky", "arrange"],
  ["more reverb on the snare", "mix"],
  ["viac reverbu na kick", "mix"],
  ["menej reverbu na snare", "mix"],
  ["loudness na -11", "loudness"],
  ["hlasitosť na -12", "loudness"],
  ["mute the chords and set the lead to 30%", "compound"],
  ["stíš bicie a zvýš basu", "compound"],
  ["enable the chorus on the chords and zníž basu", "compound"],
];
let bad = 0;
for (const [q, want] of cases) {
  const r = compactIntentResponse(routeIntentText(q, doc));
  if (r.kind !== want) {
    bad += 1;
    console.log("FAIL", r.kind.padEnd(13), "want", want.padEnd(11), q);
  }
}
// compound short-part alias: the corpus form {kind:"bypass", intent:{...}}
setIntentModelProvider({
  id: "echo",
  async generate(i: string) {
    return i;
  },
});
const r = await tryModelRoute(
  JSON.stringify({
    kind: "compound",
    parts: [
      { kind: "bypass", intent: { effectType: "delay", target: "lead", bypassed: false } },
      { kind: "effect", intent: { effectType: "reverb", targets: ["bass"], direction: "more" } },
      { kind: "send", intent: { effectType: "chorus", target: "drums", direction: "less" } },
    ],
  }),
  doc,
);
setIntentModelProvider(null);
const ok = r?.kind === "compound" && (r as { parts: unknown[] }).parts.length === 3;
if (!ok) {
  bad += 1;
  console.log("FAIL compound short-parts:", JSON.stringify(r));
}
console.log(bad === 0 ? `ALL ${cases.length + 1} OK` : `${bad} FAILURES`);
