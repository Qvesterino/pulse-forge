import { describe, expect, it, vi } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { generateAsyncResult } from "../src/intent/pipeline";

/**
 * Canonical-path failure contract: when the underlying generator fails for
 * EVERY candidate (the worst non-abort failure), generateAsyncResult must
 * still resolve — with the deterministic fallback pattern and a truthful
 * fallbackReason — and never reject into the UI. (Abort is the single
 * sanctioned rejection.)
 */

vi.mock("../src/ai/generator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/generator")>();
  return {
    ...actual,
    generatePattern: vi.fn(() => {
      throw new Error("synthetic total generator failure");
    }),
  };
});

describe("generateAsyncResult — total generator failure", () => {
  it("resolves with the deterministic fallback pattern and a truthful fallbackReason", async () => {
    const doc = createDefaultProject();
    const result = await generateAsyncResult(doc, {
      genre: "house",
      seed: "total-failure-test",
      length: 16,
      candidateCount: 2,
    });
    expect(result.status).toBe("fallback");
    expect(result.proposal).toBeTruthy();
    expect(result.diagnostics.fallbackReason).toContain("synthetic total generator failure");
    expect(result.diagnostics.errors).toEqual([]);
    // The fallback itself is deterministic (equal input → equal output).
    const again = await generateAsyncResult(doc, {
      genre: "house",
      seed: "total-failure-test",
      length: 16,
      candidateCount: 2,
    });
    expect(again.proposal!.pattern.rows).toEqual(result.proposal!.pattern.rows);
  });
});
