import { describe, it, expect } from "vitest";
import {
  MULTIVOICE_GOLDEN_CASES,
  MULTIVOICE_GOLDEN_EXPECTED,
  generateGoldenVoice,
  multivoiceHash,
} from "./fixtures/multivoice-golden";

describe("multi-voice golden (P2+P3 regression lock)", () => {
  it("freezes output identity for every genre", () => {
    expect(MULTIVOICE_GOLDEN_CASES).toHaveLength(8);
    for (const testCase of MULTIVOICE_GOLDEN_CASES) {
      const expected = MULTIVOICE_GOLDEN_EXPECTED.find((item) => item.caseId === testCase.id);
      expect(expected, `missing fixture ${testCase.id}`).toBeDefined();
      expect(multivoiceHash(generateGoldenVoice(testCase))).toBe(expected!.hash);
    }
  });

  it("every golden voice is a full band (sanity against empty regressions)", () => {
    for (const testCase of MULTIVOICE_GOLDEN_CASES) {
      const result = generateGoldenVoice(testCase);
      expect(result.bass.length, `${testCase.id} bass`).toBeGreaterThan(0);
      expect(result.chord.length, `${testCase.id} chord`).toBeGreaterThan(0);
      expect(result.lead.length, `${testCase.id} lead`).toBeGreaterThan(0);
      expect(result.progressionName, `${testCase.id} progression`).toBeTruthy();
    }
  });
});
