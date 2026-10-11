import { testDoc } from "../tests/fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { generatePattern } from "../src/ai/generator";
import { inspectPatternInvariants } from "../src/ai/invariants";

const doc = testDoc();
const input = normalizeIntent({ genre: "techno", seed: "gate-explicit BPM + genre", candidateCount: 3, roles: ["lead"] });
const plan = planGeneration(input, doc);
console.log("candidateSeeds:", JSON.stringify(plan.candidateSeeds));
for (const seed of plan.candidateSeeds) {
  try {
    const options = { ...plan.options, seed };
    const pattern = generatePattern(doc, options);
    const inv = inspectPatternInvariants(doc, pattern);
    const noteCount = Object.values(pattern.notes ?? {}).reduce((a, b) => a + (b as unknown[]).length, 0);
    console.log(`seed=${JSON.stringify(seed)} rows=${Object.keys(pattern.rows).length} notes=${noteCount} invariantOk=${inv.ok} ${inv.ok ? "" : JSON.stringify(inv.errors).slice(0, 120)}`);
  } catch (e) {
    console.log(`seed=${JSON.stringify(seed)} THREW:`, (e as Error).message);
  }
}
