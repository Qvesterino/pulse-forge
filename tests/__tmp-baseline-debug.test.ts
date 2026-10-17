import { describe, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { generatePattern } from "../src/ai/generator";
import { canonicalizePattern, contentHash, measurePattern } from "../src/ai/evaluation";
import { AI_BASELINE_CASES, BASELINE_STEP_COUNTS, baselineOptions } from "./fixtures/ai-baseline";
import { AI_CORRECTNESS_EXPECTED } from "./fixtures/ai-correctness.expected";

describe("tmp baseline diff", () => {
  it("dump diffs", () => {
    for (const testCase of AI_BASELINE_CASES) {
      for (const stepCount of BASELINE_STEP_COUNTS) {
        const expected = AI_CORRECTNESS_EXPECTED.find(
          (item) => item.caseId === testCase.id && item.stepCount === stepCount,
        )!;
        const doc = createDefaultProject();
        const pattern = generatePattern(doc, baselineOptions(testCase, stepCount));
        const canonical = canonicalizePattern(doc, pattern);
        const hash = contentHash(canonical);
        const metrics = measurePattern(pattern as never);
        const hashChanged = hash !== expected.contentHash;
        const metricKeys = new Set([...Object.keys(metrics), ...Object.keys(expected.metrics ?? {})]);
        const metricDiffs: string[] = [];
        for (const key of metricKeys) {
          const a = (metrics as Record<string, unknown>)[key];
          const b = (expected.metrics as unknown as Record<string, unknown>)[key];
          if (JSON.stringify(a) !== JSON.stringify(b)) metricDiffs.push(`${key}: ${String(b)} -> ${String(a)}`);
        }
        if (hashChanged || metricDiffs.length > 0) {
          console.log(`DIFF ${testCase.id}/${stepCount} hash=${expected.contentHash}->${hash}`);
          for (const d of metricDiffs) console.log(`   ${d}`);
        }
      }
    }
    console.log("DONE");
  });
});
