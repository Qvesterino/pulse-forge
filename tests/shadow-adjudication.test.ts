import { describe, expect, it } from "vitest";
import { adjudicateShadow, winnerCandidateIndexAtWeight } from "../src/intent/shadow-adjudication";
import type { AudioFitObservationV1 } from "../src/intent/audio-fit-ledger";

/**
 * SHADOW ADJUDICATION — CI for taste.
 *
 * The claim under test: given the recorded finalist coordinates and the human's
 * own pick, the report says WHICH audio-weight policy would have chosen what
 * the human kept — and it refuses to pretend when there is nothing to compare.
 */

function observation(
  generationId: string,
  candidates: Array<{ index: number; firstPass: number; audio: number }>,
): AudioFitObservationV1 {
  return {
    version: 1,
    generationId,
    genre: "house",
    createdAt: 1,
    selectedIndex: 0,
    candidates: candidates.map((candidate) => ({
      candidateIndex: candidate.index,
      firstPass: candidate.firstPass,
      audio: candidate.audio,
      selected: false,
    })),
  };
}

/** The engine's winner leans on the ranker; the human prefers the audio fit. */
const RANKER_LEAN = observation("gen-1", [
  { index: 0, firstPass: 0.9, audio: 0.2 },
  { index: 1, firstPass: 0.2, audio: 0.9 },
]);
const AUDIO_LEAN = observation("gen-2", [
  { index: 0, firstPass: 0.8, audio: 0.1 },
  { index: 1, firstPass: 0.3, audio: 0.95 },
]);

describe("winnerCandidateIndexAtWeight", () => {
  it("picks the first-pass leader at weight 0 and the audio leader at weight 1", () => {
    expect(winnerCandidateIndexAtWeight(RANKER_LEAN, 0)).toBe(0);
    expect(winnerCandidateIndexAtWeight(RANKER_LEAN, 1)).toBe(1);
  });

  it("breaks ties by the smaller candidateIndex (the rerank's own rule)", () => {
    const tied = observation("gen-tie", [
      { index: 0, firstPass: 0.5, audio: 0.5 },
      { index: 1, firstPass: 0.5, audio: 0.5 },
    ]);
    expect(winnerCandidateIndexAtWeight(tied, 0.5)).toBe(0);
  });

  it("returns null for an observation with no candidates", () => {
    const empty = { ...RANKER_LEAN, candidates: [] } as unknown as AudioFitObservationV1;
    expect(winnerCandidateIndexAtWeight(empty, 0.3)).toBeNull();
  });
});

describe("adjudicateShadow", () => {
  it("refuses to stage an experiment when both policies are the same weight", () => {
    const report = adjudicateShadow({
      observations: [RANKER_LEAN],
      activeWeight: 0.3,
      shadowWeight: 0.3,
      humanPicks: new Map([["gen-1", 1]]),
    });
    expect(report.verdict).toBe("tie");
    expect(report.detail).toContain("nothing to adjudicate");
    expect(report.rows).toEqual([]);
  });

  it("declares the SHADOW the better policy when its ordering matches the human more often", () => {
    // The human kept the audio-leaning candidate both times.
    const report = adjudicateShadow({
      observations: [RANKER_LEAN, AUDIO_LEAN],
      activeWeight: 0, // the policy in force ignores audio
      shadowWeight: 1, // the trialled policy follows it
      humanPicks: new Map([
        ["gen-1", 1],
        ["gen-2", 1],
      ]),
    });
    expect(report.verdict).toBe("shadow");
    expect(report).toMatchObject({ adjudicable: 2, activeAgreed: 0, shadowAgreed: 2, neitherAgreed: 0 });
    expect(report.detail).toContain("SHADOW policy agreed");
  });

  it("keeps the ACTIVE policy when it already agrees", () => {
    const report = adjudicateShadow({
      observations: [RANKER_LEAN, AUDIO_LEAN],
      activeWeight: 1,
      shadowWeight: 0,
      humanPicks: new Map([
        ["gen-1", 1],
        ["gen-2", 1],
      ]),
    });
    expect(report.verdict).toBe("active");
    expect(report.detail).toContain("keep the active policy");
  });

  it("counts generations the two policies cannot separate, and still says tie when they agree equally", () => {
    const bothSame = observation("gen-same", [
      { index: 0, firstPass: 0.9, audio: 0.9 },
      { index: 1, firstPass: 0.1, audio: 0.1 },
    ]);
    const report = adjudicateShadow({
      observations: [bothSame, bothSame],
      activeWeight: 0,
      shadowWeight: 1,
      humanPicks: new Map([
        ["gen-same", 0],
        ["gen-same-2", 0],
      ]),
    });
    expect(report.verdict).toBe("tie");
    expect(report.indistinguishable).toBe(2);
  });

  it("counts a pick NEITHER policy would make", () => {
    const report = adjudicateShadow({
      observations: [RANKER_LEAN, AUDIO_LEAN],
      activeWeight: 0,
      shadowWeight: 0.05,
      humanPicks: new Map([
        ["gen-1", 1],
        ["gen-2", 0],
      ]),
    });
    // At both weights the policies pick the first-pass leader (index 0):
    // gen-1's human pick (index 1) is made by neither.
    expect(report.neitherAgreed).toBe(1);
    expect(report.activeAgreed).toBe(1);
    expect(report.shadowAgreed).toBe(1);
  });

  it("needs at least two human picks to reach a verdict", () => {
    const report = adjudicateShadow({
      observations: [RANKER_LEAN, AUDIO_LEAN],
      activeWeight: 0,
      shadowWeight: 1,
      humanPicks: new Map([["gen-1", 1]]),
    });
    expect(report.verdict).toBe("no-evidence");
    expect(report.detail).toContain("at least 2 human picks");
  });
});
