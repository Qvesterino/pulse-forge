import { performance } from "node:perf_hooks";
import { generateLocalResultFromOptions } from "../src/intent/pipeline.ts";
import { createDefaultProject } from "../src/project-model/schema.ts";
import { AI_BASELINE_CASES, baselineOptions } from "../tests/fixtures/ai-baseline.ts";
import { MAX_SYNC_PREVIEW_MS } from "../src/ai/performance.ts";

const doc = createDefaultProject();
const rows = [];
const sampleCount = 20;
for (const stepCount of [16, 32, 64]) {
  const options = baselineOptions(AI_BASELINE_CASES[0], stepCount);
  // Two warmups keep the gate focused on generation rather than first-call JIT work.
  generateLocalResultFromOptions(doc, options, "preview");
  generateLocalResultFromOptions(doc, options, "preview");
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index++) {
    const start = performance.now();
    generateLocalResultFromOptions(doc, options, "preview");
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];
  rows.push({ stepCount, minMs: samples[0], medianMs: samples[Math.floor(samples.length / 2)], p95Ms: p95, maxMs: samples.at(-1) });
  if (p95 > MAX_SYNC_PREVIEW_MS) throw new Error(`${stepCount}-step preview p95 ${p95.toFixed(2)}ms exceeds ${MAX_SYNC_PREVIEW_MS}ms`);
}

console.log(JSON.stringify({ budgetMs: MAX_SYNC_PREVIEW_MS, rows }, null, 2));
