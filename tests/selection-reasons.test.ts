import { describe, expect, it } from "vitest";
import {
  CLEAR_LEAD_MARGIN,
  explainSelection,
  formatSelectionReasons,
  type SelectionReasonEntry,
} from "../src/intent/selection-reasons";
import { createDefaultProject } from "../src/project-model/schema";
import { generateAsyncResultFromOptions } from "../src/intent/pipeline";
import type { GenerateOptions } from "../src/ai/types";

/**
 * WAVE E1 — SELECTION REASONS.
 *
 * The contract: a reason is derived from MEASURED data or it is not emitted.
 * These specs pin every code, the honest empties, and that the whole thing
 * reaches a real pipeline run (`result.selection.rationale`).
 */

function entry(overrides: Partial<SelectionReasonEntry> & { candidateIndex: number }): SelectionReasonEntry {
  return { score: 0.5, ...overrides };
}

describe("explainSelection — honest empties", () => {
  it("says so when nothing survived the gates", () => {
    const reasons = explainSelection({ bank: [], selectedIndex: null });
    expect(reasons).toEqual([
      { code: "no-candidates", text: "No candidate survived the gates — nothing was applied." },
    ]);
  });

  it("does NOT claim a gate wipeout for a single-candidate run that succeeded", () => {
    const reasons = explainSelection({ bank: [], selectedIndex: null, proposalExists: true });
    expect(reasons.map((reason) => reason.code)).toEqual(["direct-pick"]);
    expect(reasons[0]!.text).toContain("no bank ranking happened");
  });

  it("says so when only one candidate survived — no ranking happened", () => {
    const reasons = explainSelection({ bank: [entry({ candidateIndex: 0 })], selectedIndex: 0 });
    expect(reasons.map((reason) => reason.code)).toEqual(["single-candidate"]);
    expect(reasons[0]!.text).toContain("no ranking was needed");
  });

  it("emits nothing when the selection index is unknown", () => {
    expect(
      explainSelection({ bank: [entry({ candidateIndex: 0 }), entry({ candidateIndex: 1 })], selectedIndex: null }),
    ).toEqual([]);
  });
});

describe("explainSelection — the acting stage speaks first", () => {
  it("credits the deterministic fit score when it produced the order", () => {
    const reasons = explainSelection({
      bank: [
        entry({ candidateIndex: 0, score: 0.9 }),
        entry({ candidateIndex: 1, score: 0.6 }),
        entry({ candidateIndex: 2, score: 0.5 }),
      ],
      selectedIndex: 0,
    });
    expect(reasons[0]).toMatchObject({ code: "heuristic-top" });
    expect(reasons[0]!.text).toContain("0.900");
  });

  it("credits the learned ranker in active mode", () => {
    const reasons = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.7 }), entry({ candidateIndex: 1, score: 0.8 })],
      selectedIndex: 0,
      rankerMode: "active",
      rankerSource: "model",
    });
    expect(reasons[0]).toMatchObject({ code: "ranker-model" });
    expect(reasons.some((reason) => reason.code === "heuristic-top")).toBe(false);
  });

  it("credits the audio rerank for the displacement, with both indices", () => {
    const reasons = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.7 }), entry({ candidateIndex: 2, score: 0.6 })],
      selectedIndex: 0,
      audioRerank: { displacedCandidateIndex: 2, selectedCandidateIndex: 0, personalized: true },
    });
    expect(reasons[0]).toMatchObject({ code: "audio-rerank" });
    expect(reasons[0]!.text).toContain("#1");
    expect(reasons[0]!.text).toContain("#3");
    expect(reasons.some((reason) => reason.code === "personal-taste")).toBe(true);
  });
});

describe("explainSelection — confidence and taste", () => {
  it("calls a lead clear above the margin and narrow below it", () => {
    const clear = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.9 }), entry({ candidateIndex: 1, score: 0.9 - CLEAR_LEAD_MARGIN })],
      selectedIndex: 0,
    });
    expect(clear.some((reason) => reason.code === "clear-lead")).toBe(true);

    const narrow = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.9 }), entry({ candidateIndex: 1, score: 0.899 })],
      selectedIndex: 0,
    });
    const narrowReason = narrow.find((reason) => reason.code === "narrow-lead");
    expect(narrowReason?.text).toContain("audition the alternatives");
  });

  it("reports an exact tie honestly", () => {
    const reasons = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.75 }), entry({ candidateIndex: 1, score: 0.75 })],
      selectedIndex: 0,
    });
    expect(reasons.some((reason) => reason.code === "tie")).toBe(true);
  });

  it("distinguishes a personal reorder from a personal agreement — and never repeats it", () => {
    const reordered = explainSelection({
      bank: [
        entry({ candidateIndex: 0, score: 0.6, globalScore: 0.6, personalScore: 0.82 }),
        entry({ candidateIndex: 1, score: 0.7, globalScore: 0.7, personalScore: 0.55 }),
      ],
      selectedIndex: 0,
    });
    const personal = reordered.filter((reason) => reason.code === "personal-taste");
    expect(personal).toHaveLength(1);
    expect(personal[0]!.text).toContain("reordered the bank");

    const agreed = explainSelection({
      bank: [
        entry({ candidateIndex: 0, score: 0.8, globalScore: 0.8, personalScore: 0.8 }),
        entry({ candidateIndex: 1, score: 0.5, globalScore: 0.6, personalScore: 0.4 }),
      ],
      selectedIndex: 0,
    });
    const agreedReason = agreed.find((reason) => reason.code === "personal-taste");
    expect(agreedReason?.text).toContain("agreed with this pick");
  });

  it("reports a tempo substitution only when the resolve landed outside the request", () => {
    const outside = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.9 }), entry({ candidateIndex: 1, score: 0.4 })],
      selectedIndex: 0,
      resolvedBpm: 128,
      requestedBpmRange: [140, 150],
    });
    expect(outside.some((reason) => reason.code === "tempo-resolved")).toBe(true);

    const inside = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.9 }), entry({ candidateIndex: 1, score: 0.4 })],
      selectedIndex: 0,
      resolvedBpm: 145,
      requestedBpmRange: [140, 150],
    });
    expect(inside.some((reason) => reason.code === "tempo-resolved")).toBe(false);
  });
});

describe("formatSelectionReasons", () => {
  it("joins the sentences and stays empty for no reasons", () => {
    const reasons = explainSelection({
      bank: [entry({ candidateIndex: 0, score: 0.9 }), entry({ candidateIndex: 1, score: 0.5 })],
      selectedIndex: 0,
    });
    const line = formatSelectionReasons(reasons);
    expect(line).toContain("Highest deterministic fit score");
    expect(line).toContain("Clear lead");
    expect(formatSelectionReasons([])).toBe("");
  });
});

describe("pipeline integration — the real run carries the rationale", () => {
  it("attaches measured reasons to the selection of a REAL generation", async () => {
    const doc = createDefaultProject();
    const options: GenerateOptions = {
      genre: "house",
      style: "Driving",
      seed: "selection-reasons-e1",
      stepCount: 16,
      ghostWeight: 0.3,
      microWeight: 0.2,
      velocityVariation: 0.3,
      temperature: 1,
      replaceMode: "new",
      applyGrooveSettings: false,
      // A multi-candidate run is what builds a bank at all (the provider takes
      // the sync single-candidate fast path otherwise — `direct-pick`).
      candidateCount: 4,
    };
    const result = await generateAsyncResultFromOptions(doc, options, { includeBank: true });
    expect(result.bank?.length ?? 0).toBeGreaterThan(1);
    const selection = result.selection;
    expect(selection).toBeDefined();
    expect(Array.isArray(selection!.reasons)).toBe(true);
    expect((selection!.reasons ?? []).length).toBeGreaterThan(0);
    expect(typeof selection!.rationale).toBe("string");
    expect(selection!.rationale!.length).toBeGreaterThan(0);
    // The rationale names the stage that acted or the lead — never silence.
    expect(selection!.rationale).toMatch(/fit score|ranker|auditioning the render|lead|Tied/);
  });
});
