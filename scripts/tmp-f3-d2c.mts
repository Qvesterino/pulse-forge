import { testDoc } from "../tests/fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { generatePattern } from "../src/ai/generator";
import { candidatePlan } from "../src/intent/providers/candidate";
import { briefGateViolations } from "../src/intent/brief-gate";

const doc = testDoc();
const input = normalizeIntent({ genre: "techno", seed: "gate-explicit BPM + genre", candidateCount: 3, roles: ["lead"] });
const plan = planGeneration(input, doc);
const vp = candidatePlan(plan, "gate-explicit BPM + genre|candidate:1");
console.log("validationPlan roles:", vp.intent.roles, "| generationPlan roles:", vp.options.roles);
console.log("validationPlan length:", vp.options.length, "| base plan length:", plan.options.length);
const pattern = generatePattern(doc, vp.options);
const noteCount = Object.values(pattern.notes ?? {}).reduce((a, b) => a + (b as unknown[]).length, 0);
console.log("generated rows:", Object.keys(pattern.rows).length, "notes:", noteCount);
const violations = briefGateViolations(pattern, vp, { project: doc });
console.log("briefGateViolations:", JSON.stringify(violations));
