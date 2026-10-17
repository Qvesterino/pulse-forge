import { describe, expect, it } from "vitest";
import type { AudioFitObservationV1 } from "../src/intent/audio-fit-ledger";
import { audioFitLedgerSamples } from "../src/intent/audio-fit-ledger";
import type { ReactionEntry } from "../src/intent/reaction-ledger";
import { rerankVerdictsFromEntries, reactionAdjustedFitSamples } from "../src/intent/reaction-rerank-feedback";
import { fitRerankWeight } from "../src/intent/rerank-weights";

/**
 * F2 CLOSURE — REACTIONS FEED THE RERANK FIT.
 *
 * The honest rules under test: an undone apply DROPS the generation (training
 * toward a rejected pick is worse than no sample), a kept/tweaked apply
 * RE-TARGETS the ground truth to the candidate the human chose, and nothing
 * else moves. The strongest spec below proves the feed changes the FITTED
 * WEIGHT — not just a field.
 */

function entry(overrides: Partial<ReactionEntry> = {}): ReactionEntry {
  return {
    id: "rx-1",
    createdAt: 1,
    routeKind: "candidateUse",
    action: "generate:pattern:abs",
    trackIds: [],
    beforeHash: "aaaaaaaa",
    afterHash: "bbbbbbbb",
    outcome: "kept",
    resolvedAt: 2,
    ...overrides,
  };
}

function observation(overrides: Partial<AudioFitObservationV1> = {}): AudioFitObservationV1 {
  return {
    version: 1,
    generationId: "gen-111",
    genre: "house",
    createdAt: 10,
    selectedIndex: 0,
    candidates: [
      { candidateIndex: 0, firstPass: 0.9, audio: 0.2, selected: true },
      { candidateIndex: 1, firstPass: 0.2, audio: 0.9, selected: false },
    ],
    ...overrides,
  };
}

describe("rerankVerdictsFromEntries", () => {
  it("keeps only generation-tagged RESOLVED verdicts", () => {
    const verdicts = rerankVerdictsFromEntries([
      entry({ generationId: "gen-111", candidateIndex: 1, outcome: "kept" }),
      entry({ generationId: "gen-222", outcome: "pending" }),
      entry({ generationId: undefined, outcome: "undone" }),
      entry({ generationId: "gen-333", outcome: "tweaked" }),
    ]);
    expect([...verdicts.keys()]).toEqual(["gen-111", "gen-333"]);
    expect(verdicts.get("gen-111")).toEqual({ outcome: "kept", candidateIndex: 1 });
  });

  it("lets the LAST resolved verdict win (a later undo overrules an earlier keep)", () => {
    const verdicts = rerankVerdictsFromEntries([
      entry({ generationId: "gen-111", outcome: "kept" }),
      entry({ generationId: "gen-111", outcome: "undone" }),
    ]);
    expect(verdicts.get("gen-111")?.outcome).toBe("undone");
  });
});

describe("reactionAdjustedFitSamples", () => {
  it("is byte-identical to the unadjusted ledger read when nobody reacted", () => {
    const observations = [observation(), observation({ generationId: "gen-222" })];
    const adjusted = reactionAdjustedFitSamples(observations, new Map());
    expect(adjusted.samples).toEqual(audioFitLedgerSamples(observations));
    expect(adjusted.report).toEqual({ generations: 2, dropped: 0, retargeted: 0, untouched: 2 });
  });

  it("drops a generation whose applied candidate the human reverted", () => {
    const observations = [observation(), observation({ generationId: "gen-222" })];
    const adjusted = reactionAdjustedFitSamples(
      observations,
      rerankVerdictsFromEntries([entry({ generationId: "gen-111", outcome: "undone" })]),
    );
    expect(adjusted.report).toEqual({ generations: 2, dropped: 1, retargeted: 0, untouched: 1 });
    expect(adjusted.samples.every((sample) => sample.generationId === "gen-222")).toBe(true);
  });

  it("re-targets the kept candidate to the one the HUMAN applied", () => {
    const observations = [observation()];
    const adjusted = reactionAdjustedFitSamples(
      observations,
      rerankVerdictsFromEntries([entry({ generationId: "gen-111", candidateIndex: 1, outcome: "kept" })]),
    );
    expect(adjusted.report).toEqual({ generations: 1, dropped: 0, retargeted: 1, untouched: 0 });
    const kept = adjusted.samples.find((sample) => sample.kept);
    expect(kept?.firstPass).toBe(0.2); // the audio-leaning candidate the human picked
  });

  it("treats a correction (tweaked) as a kept choice, and leaves a matching pick alone", () => {
    const tweaked = reactionAdjustedFitSamples(
      [observation()],
      rerankVerdictsFromEntries([entry({ generationId: "gen-111", candidateIndex: 1, outcome: "tweaked" })]),
    );
    expect(tweaked.report.retargeted).toBe(1);

    const same = reactionAdjustedFitSamples(
      [observation()],
      rerankVerdictsFromEntries([entry({ generationId: "gen-111", candidateIndex: 0, outcome: "kept" })]),
    );
    expect(same.report).toEqual({ generations: 1, dropped: 0, retargeted: 0, untouched: 1 });
  });

  it("ignores a verdict whose candidate is not in the observation", () => {
    const adjusted = reactionAdjustedFitSamples(
      [observation()],
      rerankVerdictsFromEntries([entry({ generationId: "gen-111", candidateIndex: 7, outcome: "kept" })]),
    );
    expect(adjusted.report.untouched).toBe(1);
  });

  it("CHANGES THE FITTED WEIGHT: two human picks against the engine's winners move it off zero", () => {
    // The engine delivered the first-pass-leading candidate in both
    // generations, so the unadjusted fit prefers weight 0 (pure ranker).
    const observations = [observation(), observation({ generationId: "gen-222" })];
    const beforeFit = fitRerankWeight(audioFitLedgerSamples(observations));
    expect(beforeFit?.weight).toBe(0);
    expect(beforeFit?.accuracy).toBe(1);

    // Both times the human applied the AUDIO-leaning candidate instead.
    const verdicts = rerankVerdictsFromEntries([
      entry({ id: "rx-a", generationId: "gen-111", candidateIndex: 1, outcome: "kept" }),
      entry({ id: "rx-b", generationId: "gen-222", candidateIndex: 1, outcome: "kept" }),
    ]);
    const adjusted = reactionAdjustedFitSamples(observations, verdicts);
    const afterFit = fitRerankWeight(adjusted.samples);

    expect(afterFit).not.toBeNull();
    expect(afterFit!.weight).toBeGreaterThan(0);
    expect(afterFit!.accuracy).toBe(1);
    expect(afterFit!.baselineAccuracy).toBe(0); // at weight 0 it now picks the rejected candidate
  });
});
