import { testDoc } from "../tests/fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { generatePattern } from "../src/ai/generator";

const doc = testDoc();
const noteCount = (options: Record<string, unknown>) => {
  const input = normalizeIntent(options);
  const pattern = generatePattern(doc, planGeneration(input, doc).options);
  return Object.values(pattern.notes ?? {}).reduce((a, b) => a + (b as unknown[]).length, 0);
};
const base = { genre: "techno", seed: "s", candidateCount: 1, roles: ["lead"] };
console.log("bare:", noteCount(base));
console.log("+style:", noteCount({ ...base, style: "rolling" }));
console.log("+mood:", noteCount({ ...base, mood: "dark" }));
console.log("+energy:", noteCount({ ...base, energy: 0.3 }));
console.log("+variation:", noteCount({ ...base, variation: 0.6 }));
console.log("+bpm:", noteCount({ ...base, bpmRange: [140, 140] }));
console.log("+text:", noteCount({ ...base, text: "dark rolling techno at 140 with lead" }));
