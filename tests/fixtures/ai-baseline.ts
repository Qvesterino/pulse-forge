import type { GenerateOptions } from "../../src/ai/types";

export const BASELINE_STEP_COUNTS = [16, 32, 64] as const;

export interface AiBaselineCase {
  id: string;
  genre: GenerateOptions["genre"];
  grooveId: string;
  style: string;
  seed: string;
}

/** Stable representative styles used by the baseline harness. */
export const AI_BASELINE_CASES: readonly AiBaselineCase[] = [
  { id: "house-driving", genre: "house", grooveId: "house.driving", style: "Driving", seed: "baseline-house-driving-v1" },
  { id: "house-minimal", genre: "house", grooveId: "house.minimal", style: "Minimal", seed: "baseline-house-minimal-v1" },
  { id: "techno-driving", genre: "techno", grooveId: "techno.driving", style: "Driving", seed: "baseline-techno-driving-v1" },
  { id: "techno-minimal", genre: "techno", grooveId: "techno.minimal", style: "Minimal", seed: "baseline-techno-minimal-v1" },
  { id: "trap-classic", genre: "trap", grooveId: "trap.classic", style: "Classic", seed: "baseline-trap-classic-v1" },
  { id: "trap-rolling", genre: "trap", grooveId: "trap.rolling", style: "Rolling", seed: "baseline-trap-rolling-v1" },
  { id: "ambient-drifting", genre: "ambient", grooveId: "ambient.drifting", style: "Drifting", seed: "baseline-ambient-drifting-v1" },
  { id: "ambient-glitch", genre: "ambient", grooveId: "ambient.glitch", style: "Glitch", seed: "baseline-ambient-glitch-v1" },
];

export function baselineOptions(testCase: AiBaselineCase, stepCount: number): GenerateOptions {
  return {
    genre: testCase.genre,
    style: testCase.style,
    seed: testCase.seed,
    stepCount,
    ghostWeight: 0.3,
    microWeight: 0.2,
    velocityVariation: 0.3,
    temperature: 1,
    replaceMode: "new",
    applyGrooveSettings: false,
  };
}
