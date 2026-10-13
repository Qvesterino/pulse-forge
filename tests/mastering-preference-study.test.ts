import { describe, expect, it, vi } from "vitest";
import {
  createStudyPairId,
  createStudyReviewerHash,
  createStudySourceMixHash,
  createStudyRandomToken,
} from "../src/mastering/preference-study";

describe("local mastering preference study identities", () => {
  it("creates opaque bounded pair IDs and one-way reviewer hashes", () => {
    const pairId = createStudyPairId();
    const firstToken = "1".repeat(64);
    const secondToken = "2".repeat(64);
    const firstReviewer = createStudyReviewerHash(firstToken);
    const secondReviewer = createStudyReviewerHash(secondToken);

    expect(pairId).toMatch(/^pair-[0-9a-f]{32}$/);
    expect(firstReviewer).toMatch(/^[0-9a-f]{64}$/);
    expect(secondReviewer).toMatch(/^[0-9a-f]{64}$/);
    expect(secondReviewer).not.toBe(firstReviewer);
    expect(createStudyReviewerHash(firstToken)).toBe(firstReviewer);
    expect(() => createStudyReviewerHash("reviewer-one")).toThrow(/64-digit anonymous code/);
  });

  it("salts the source mix hash and never returns the raw project revision", () => {
    const revision = "a".repeat(64);
    const salt = "b".repeat(64);
    const first = createStudySourceMixHash(revision, salt);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(revision);
    expect(createStudySourceMixHash(revision, "c".repeat(64))).not.toBe(first);
    expect(createStudySourceMixHash("d".repeat(64), salt)).not.toBe(first);
  });

  it("requires cryptographically secure randomness", () => {
    vi.stubGlobal("crypto", {});
    expect(() => createStudyRandomToken()).toThrow(/Secure local random numbers/);
    vi.unstubAllGlobals();
  });
});
