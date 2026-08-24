import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { generatePattern, resolveGroove } from "../src/ai/generator";
import {
  canonicalJson,
  canonicalizePattern,
  contentHash,
  createGenerationRecipe,
  LOCAL_ENGINE_ID,
  LOCAL_ENGINE_VERSION,
  measurePattern,
} from "../src/ai/evaluation";
import { getGrooveById } from "../src/ai/grooves/index";
import { AI_BASELINE_CASES, BASELINE_STEP_COUNTS, baselineOptions } from "./fixtures/ai-baseline";
import { AI_CORRECTNESS_EXPECTED } from "./fixtures/ai-correctness.expected";

function expectedFor(caseId: string, stepCount: number) {
  return AI_CORRECTNESS_EXPECTED.find((item) => item.caseId === caseId && item.stepCount === stepCount);
}

describe("AI baseline harness", () => {
  it("has a resolved groove for every baseline case", () => {
    for (const testCase of AI_BASELINE_CASES) {
      const groove = getGrooveById(testCase.grooveId);
      expect(groove?.genre).toBe(testCase.genre);
      expect(resolveGroove(testCase.genre, testCase.style).id).toBe(testCase.grooveId);
    }
  });

  it("canonicalizes equivalent projects without UUID differences", () => {
    const firstDoc = createDefaultProject();
    const secondDoc = createDefaultProject();
    const testCase = AI_BASELINE_CASES[0];
    const options = baselineOptions(testCase, 16);

    const first = canonicalizePattern(firstDoc, generatePattern(firstDoc, options));
    const second = canonicalizePattern(secondDoc, generatePattern(secondDoc, options));

    expect(contentHash(first)).toBe(contentHash(second));
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("covers every genre/style case at every baseline length", () => {
    expect(AI_BASELINE_CASES).toHaveLength(8);
    expect(BASELINE_STEP_COUNTS).toEqual([16, 32, 64]);
    expect(AI_CORRECTNESS_EXPECTED).toHaveLength(AI_BASELINE_CASES.length * BASELINE_STEP_COUNTS.length);
  });

  it("matches the frozen correctness-1 hashes and metrics", () => {
    const firstCase = AI_BASELINE_CASES[0];
    const firstRecipe = createGenerationRecipe(baselineOptions(firstCase, 16), firstCase.grooveId);
    expect(firstRecipe.engineId).toBe(LOCAL_ENGINE_ID);
    expect(firstRecipe.engineVersion).toBe(LOCAL_ENGINE_VERSION);

    for (const testCase of AI_BASELINE_CASES) {
      for (const stepCount of BASELINE_STEP_COUNTS) {
        const expected = expectedFor(testCase.id, stepCount);
        expect(expected, `missing fixture ${testCase.id}/${stepCount}`).toBeDefined();

        const doc = createDefaultProject();
        const options = baselineOptions(testCase, stepCount);
        const pattern = generatePattern(doc, options);
        const canonical = canonicalizePattern(doc, pattern);

        expect({
          caseId: testCase.id,
          stepCount,
          grooveId: testCase.grooveId,
          contentHash: contentHash(canonical),
          metrics: measurePattern(pattern),
        }).toEqual(expected);
      }
    }
  });
});
