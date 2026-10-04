import { describe, it, expect, beforeEach } from "vitest";
import { FEATURE_V2_COUNT, FEATURE_V2_NAMES } from "../src/ai/features/pattern-features-v2";
import {
  PROBE_PATIENCE,
  proactiveProbeState,
  noteGenerationWithoutVote,
  noteProducerDnaVote,
  noteProbeDismissed,
  generationsWithoutProducerDnaVote,
  resetProactiveProbe,
  comparedPairKeys,
} from "../src/intent/proactive-probe";

/**
 * W3 — proactive taste probes.
 *
 * The contract that keeps this feature acceptable is restraint: it asks ONCE,
 * only after real patience, only on a controlled pair, and never while
 * learning is paused. A probe that nags is worse than no probe.
 */

const SCORE_VERSION = "global-selector.v1:heuristic";

/** Build a candidate whose only measurable difference is `featureName`. */
function candidate(contentHash: string, index: number, globalScore: number, featureName: string, value: number) {
  const values = new Array(FEATURE_V2_COUNT).fill(0.5);
  values[FEATURE_V2_NAMES.indexOf(featureName)] = value;
  return {
    candidate: { candidateIndex: index, contentHash },
    candidateIndex: index,
    contentHash,
    features: values,
    globalScore,
    globalScoreVersion: SCORE_VERSION,
  };
}

describe("proactive probe — decision logic", () => {
  it("waits for patience before asking", () => {
    const candidates = [
      candidate("hash-a", 0, 0.5, "bass.noteDensity", 0.1),
      candidate("hash-b", 1, 0.51, "bass.noteDensity", 0.9),
    ];
    const state = proactiveProbeState({
      candidates,
      generationsWithoutVote: PROBE_PATIENCE - 1,
      learningEnabled: true,
    });
    expect(state.proposal).toBeNull();
    expect(state.reason).toBe("patience");
    expect(state.remaining).toBe(1);
  });

  it("asks once patience is spent, on the controlled pair", () => {
    const candidates = [
      candidate("hash-a", 0, 0.5, "bass.noteDensity", 0.1),
      candidate("hash-b", 1, 0.51, "bass.noteDensity", 0.9),
    ];
    const state = proactiveProbeState({ candidates, generationsWithoutVote: PROBE_PATIENCE, learningEnabled: true });
    expect(state.reason).toBe("ready");
    expect(state.proposal).not.toBeNull();
    expect(state.proposal!.reason).toBe("bass");
  });

  it("stays silent while learning is paused, even when impatient", () => {
    const candidates = [
      candidate("hash-a", 0, 0.5, "bass.noteDensity", 0.1),
      candidate("hash-b", 1, 0.51, "bass.noteDensity", 0.9),
    ];
    const state = proactiveProbeState({
      candidates,
      generationsWithoutVote: PROBE_PATIENCE * 5,
      learningEnabled: false,
    });
    expect(state.proposal).toBeNull();
    expect(state.reason).toBe("learning-paused");
  });

  it("never proposes a pair that was already compared here", () => {
    const candidates = [
      candidate("hash-a", 0, 0.5, "bass.noteDensity", 0.1),
      candidate("hash-b", 1, 0.51, "bass.noteDensity", 0.9),
    ];
    const excluded = new Set([JSON.stringify(["hash-a", "hash-b"].sort())]);
    const state = proactiveProbeState({
      candidates,
      generationsWithoutVote: PROBE_PATIENCE,
      learningEnabled: true,
      excludedPairKeys: excluded,
    });
    expect(state.proposal).toBeNull();
    expect(state.reason).toBe("no-usable-pair");
  });

  it("does not ask when the bank has no controlled pair (scores too far apart)", () => {
    const candidates = [
      candidate("hash-a", 0, 0.1, "bass.noteDensity", 0.1),
      candidate("hash-b", 1, 0.9, "bass.noteDensity", 0.9),
    ];
    const state = proactiveProbeState({ candidates, generationsWithoutVote: PROBE_PATIENCE, learningEnabled: true });
    expect(state.proposal).toBeNull();
  });

  it("can ask on the harmony axis too (W4 made it measurable)", () => {
    const candidates = [
      candidate("hash-a", 0, 0.5, "harmony.voicingMovement", 0.05),
      candidate("hash-b", 1, 0.52, "harmony.voicingMovement", 0.95),
    ];
    const state = proactiveProbeState({ candidates, generationsWithoutVote: PROBE_PATIENCE, learningEnabled: true });
    expect(state.proposal!.reason).toBe("harmony");
  });
});

describe("proactive probe — session streak", () => {
  beforeEach(() => {
    resetProactiveProbe();
  });

  it("counts generations, and a vote resets the streak", () => {
    expect(generationsWithoutProducerDnaVote()).toBe(0);
    noteGenerationWithoutVote();
    noteGenerationWithoutVote();
    expect(generationsWithoutProducerDnaVote()).toBe(2);
    noteProducerDnaVote();
    expect(generationsWithoutProducerDnaVote()).toBe(0);
  });

  it("a dismissal also resets the streak (ask once, then wait)", () => {
    noteGenerationWithoutVote();
    noteGenerationWithoutVote();
    noteGenerationWithoutVote();
    noteProbeDismissed();
    expect(generationsWithoutProducerDnaVote()).toBe(0);
  });
});

describe("proactive probe — compared pair bookkeeping", () => {
  it("collects only the pairs compared in THIS context", () => {
    const observations = [
      {
        context: { key: "ctx-a" },
        candidateA: { contentHash: "x" },
        candidateB: { contentHash: "y" },
      },
      {
        context: { key: "ctx-b" },
        candidateA: { contentHash: "z" },
        candidateB: { contentHash: "w" },
      },
    ];
    const keys = comparedPairKeys(observations, "ctx-a");
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(JSON.stringify(["x", "y"].sort()));
  });
});
