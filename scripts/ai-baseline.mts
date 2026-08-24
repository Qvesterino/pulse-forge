import { createDefaultProject } from "../src/project-model/schema.ts";
import { generatePattern, resolveGroove } from "../src/ai/generator.ts";
import {
  canonicalizePattern,
  contentHash,
  createGenerationRecipe,
  LOCAL_ENGINE_ID,
  LOCAL_ENGINE_VERSION,
  measurePattern,
} from "../src/ai/evaluation.ts";
import { getGrooveById } from "../src/ai/grooves/index.ts";
import { AI_BASELINE_CASES, BASELINE_STEP_COUNTS, baselineOptions } from "../tests/fixtures/ai-baseline.ts";

const cases = [];

for (const testCase of AI_BASELINE_CASES) {
  const groove = getGrooveById(testCase.grooveId);
  if (!groove) throw new Error(`Missing baseline groove ${testCase.grooveId}`);

  for (const stepCount of BASELINE_STEP_COUNTS) {
    const doc = createDefaultProject();
    const options = baselineOptions(testCase, stepCount);
    const resolved = resolveGroove(options.genre, options.style);
    if (resolved.id !== groove.id) {
      throw new Error(`Style resolution mismatch for ${testCase.id}: ${resolved.id} !== ${groove.id}`);
    }

    const pattern = generatePattern(doc, options);
    const canonical = canonicalizePattern(doc, pattern);
    cases.push({
      caseId: testCase.id,
      stepCount,
      grooveId: groove.id,
      recipe: createGenerationRecipe(options, groove.id),
      contentHash: contentHash(canonical),
      metrics: measurePattern(pattern),
    });
  }
}

console.log(JSON.stringify({
  engine: { id: LOCAL_ENGINE_ID, version: LOCAL_ENGINE_VERSION },
  cases,
}, null, 2));
