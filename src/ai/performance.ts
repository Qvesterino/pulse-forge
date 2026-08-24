import type { GenerateOptions } from "./types";
import type { ProjectDocument } from "../project-model/types";
import { generateLocalResultFromOptions } from "../intent/pipeline";

/** Maximum synchronous generation time allowed for the interactive preview. */
export const MAX_SYNC_PREVIEW_MS = 250;

export interface GenerationLatency {
  samples: number[];
  minMs: number;
  medianMs: number;
  maxMs: number;
}

export function measureGenerationLatency(
  doc: ProjectDocument,
  options: GenerateOptions,
  sampleCount = 5,
): GenerationLatency {
  // Warm the module/runtime once so the gate measures generation, not import/JIT startup.
  generateLocalResultFromOptions(doc, options, "preview");
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index++) {
    const start = performance.now();
    generateLocalResultFromOptions(doc, options, "preview");
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    minMs: sorted[0] ?? 0,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}
