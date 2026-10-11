import { testDoc } from "../tests/fixtures/doc";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { generatePattern } from "../src/ai/generator";
import { hasMelodicDialect } from "../src/ai/melodic";

const doc = testDoc();
const parsed = parseIntentText("dark rolling techno at 140 with lead");
const input = normalizeIntent({ ...parsed.input, candidateCount: 1, seed: "gate-explicit BPM + genre" });
console.log("full input:", JSON.stringify({ style: input.style, mood: input.mood, energy: input.energy, roles: input.roles }));
console.log("dialect techno/rolling:", hasMelodicDialect("techno", "rolling"));
const plan = planGeneration(input, doc);
const pattern = generatePattern(doc, plan.options);
const noteCount = Object.values(pattern.notes ?? {}).reduce((a, b) => a + (b as unknown[]).length, 0);
console.log("FULL-input generatePattern rows:", Object.keys(pattern.rows).length, "notes:", noteCount);
// and without style:
const noStyle = normalizeIntent({ ...parsed.input, style: null, candidateCount: 1, seed: "gate-explicit BPM + genre" });
const p2 = generatePattern(doc, planGeneration(noStyle, doc).options);
console.log("no-style notes:", Object.values(p2.notes ?? {}).reduce((a, b) => a + (b as unknown[]).length, 0));
