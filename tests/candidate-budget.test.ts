import { describe, expect, it } from "vitest";
import {
  AUDITION_CANDIDATE_COUNT,
  AUDITION_SYMBOLIC_CANDIDATES,
  LEAN_CANDIDATE_COUNT,
  LEAN_DEVICE_MEMORY_GB,
  intentCandidateBudget,
} from "../src/intent/candidate-budget";

/**
 * WAVE A — THE CANDIDATE BUDGET.
 *
 * The default is the product decision (a bank to audition, because a
 * single-candidate run teaches the taste loop nothing); the lean path is the
 * exception for constrained devices. These specs pin both, and pin the
 * distinction between the two pressure signals: `saveData` must NOT cost the
 * user their audition, only the model traffic.
 */

describe("intentCandidateBudget", () => {
  it("defaults to the audition-first budget", () => {
    expect(intentCandidateBudget({})).toEqual({
      candidateCount: AUDITION_CANDIDATE_COUNT,
      symbolicCandidates: AUDITION_SYMBOLIC_CANDIDATES,
      lean: false,
    });
  });

  it("on a metered connection keeps every candidate but drops the model traffic", () => {
    // Auditioning is local and cheap; the symbolic candidates are what would
    // fetch and run the ONNX prior. Metered data pays for one, not the other.
    expect(intentCandidateBudget({ saveData: true })).toEqual({
      candidateCount: AUDITION_CANDIDATE_COUNT,
      symbolicCandidates: 0,
      lean: false,
    });
  });

  it("goes lean only on a genuinely low-memory device", () => {
    expect(intentCandidateBudget({ deviceMemory: LEAN_DEVICE_MEMORY_GB })).toEqual({
      candidateCount: LEAN_CANDIDATE_COUNT,
      symbolicCandidates: 0,
      lean: true,
    });
    expect(intentCandidateBudget({ deviceMemory: 1 }).lean).toBe(true);
  });

  it("does NOT go lean at the semantic client's threshold (4 GB)", () => {
    // Refusing a ~118 MB model download at 4 GB is cheap; refusing the
    // audition — the product's core interaction — is not. The two thresholds
    // are deliberately different and this pins that they stay different.
    const budget = intentCandidateBudget({ deviceMemory: 4 });
    expect(budget.lean).toBe(false);
    expect(budget.candidateCount).toBe(AUDITION_CANDIDATE_COUNT);
  });

  it("treats missing or nonsense pressure signals as no pressure", () => {
    expect(intentCandidateBudget({ deviceMemory: undefined, saveData: undefined }).lean).toBe(false);
    expect(intentCandidateBudget({ deviceMemory: 0 }).lean).toBe(false);
  });

  it("lets the low-memory signal win over metered data (either alone is not enough)", () => {
    const budget = intentCandidateBudget({ deviceMemory: 2, saveData: true });
    expect(budget).toEqual({ candidateCount: LEAN_CANDIDATE_COUNT, symbolicCandidates: 0, lean: true });
  });
});
