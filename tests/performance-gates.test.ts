import { describe, expect, it } from "vitest";
import { MAX_SYNC_PREVIEW_MS, measureGenerationLatency } from "../src/ai/performance";
import { createDefaultProject } from "../src/project-model/schema";
import { AI_BASELINE_CASES, baselineOptions } from "./fixtures/ai-baseline";

describe("Intent Engine performance gates", () => {
  it("keeps 16/32/64-step local preview below the synchronous UI budget", () => {
    const doc = createDefaultProject();
    for (const stepCount of [16, 32, 64]) {
      const latency = measureGenerationLatency(doc, baselineOptions(AI_BASELINE_CASES[0], stepCount), 3);
      console.info(`[intent-perf] ${stepCount} steps: median=${latency.medianMs.toFixed(2)}ms max=${latency.maxMs.toFixed(2)}ms`);
      expect(latency.maxMs, `${stepCount}-step preview exceeded ${MAX_SYNC_PREVIEW_MS}ms`).toBeLessThan(MAX_SYNC_PREVIEW_MS);
    }
  });
});
