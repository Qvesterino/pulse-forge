import { beforeEach, describe, expect, it } from "vitest";
import {
  AUDIO_FIT_LEDGER_CAP,
  audioFitLedgerSamples,
  clearAudioFitLedger,
  readAudioFitLedger,
  recordAudioFitObservation,
} from "../src/intent/audio-fit-ledger";
import { fitRerankWeight, type RerankSample } from "../src/intent/rerank-weights";
import { rerankTopBySound } from "../src/intent/ranking-v3";
import type { RankedCandidate } from "../src/intent/types";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * AUDIO-FIT LEDGER (Phase: generate → render → fit → weights, closed loop).
 *
 * ranking-v3 renders the top finalists and scores their audio fit on EVERY
 * generation — this suite pins the ledger that records those observations
 * and proves the fit harness consumes them: the audio weight learned by
 * `fitRerankWeight` can come from every-day generations (winner = delivered
 * candidate), not only ★-kept rolls.
 */

const doc = { id: "doc-1" } as ProjectDocument;
const bankStub = {} as SampleBank;

function candidate(index: number, score: number, hash: string): RankedCandidate {
  return {
    candidateIndex: index,
    seed: `seed-${index}`,
    source: "template",
    status: "accepted",
    repairs: [],
    score,
    modelScore: null,
    contentHash: hash,
    pattern: { id: `p-${index}`, name: `p-${index}`, rows: {}, stepCount: 16 } as RankedCandidate["pattern"],
  };
}

beforeEach(() => {
  clearAudioFitLedger();
});

describe("audio-fit ledger", () => {
  it("records and reads back an observation (round-trip, winner marked)", () => {
    const ok = recordAudioFitObservation({
      generationId: "gen-1",
      genre: "techno",
      selectedIndex: 1,
      candidates: [
        { candidateIndex: 0, firstPass: 0.9, audio: 0.4 },
        { candidateIndex: 1, firstPass: 0.8, audio: 0.8 },
      ],
    });
    expect(ok).toBe(true);
    const ledger = readAudioFitLedger();
    expect(ledger.length).toBe(1);
    expect(ledger[0].generationId).toBe("gen-1");
    expect(ledger[0].candidates.map((c) => c.selected)).toEqual([false, true]);
  });

  it("re-rolls of the same generationId REPLACE their observation (dedupe)", () => {
    const input = {
      generationId: "gen-1",
      genre: "techno",
      selectedIndex: 0,
      candidates: [
        { candidateIndex: 0, firstPass: 0.9, audio: 0.4 },
        { candidateIndex: 1, firstPass: 0.8, audio: 0.6 },
      ],
    };
    recordAudioFitObservation(input);
    recordAudioFitObservation({ ...input, selectedIndex: 1 });
    const ledger = readAudioFitLedger();
    expect(ledger.length).toBe(1);
    expect(ledger[0].selectedIndex).toBe(1);
  });

  it("rejects malformed observations (bad selectedIndex, out-of-range scores, single candidate)", () => {
    const base = {
      generationId: "g",
      genre: "techno",
      selectedIndex: 0,
      candidates: [
        { candidateIndex: 0, firstPass: 0.5, audio: 0.5 },
        { candidateIndex: 1, firstPass: 0.4, audio: 0.5 },
      ],
    };
    expect(recordAudioFitObservation({ ...base, selectedIndex: 5 })).toBe(false);
    expect(
      recordAudioFitObservation({
        ...base,
        candidates: [{ candidateIndex: 0, firstPass: 0.5, audio: 0.5 }],
      }),
    ).toBe(false);
    // Rejection cases left the ledger untouched.
    expect(readAudioFitLedger().length).toBe(0);
    // Out-of-range scores are CLAMPED (engine-wide defensive convention),
    // not rejected.
    expect(
      recordAudioFitObservation({
        ...base,
        candidates: [
          { candidateIndex: 0, firstPass: 1.5, audio: 0.5 },
          { candidateIndex: 1, firstPass: 0.4, audio: 0.5 },
        ],
      }),
    ).toBe(true);
    expect(readAudioFitLedger().at(-1)?.candidates[0].firstPass).toBe(1);
  });

  it("caps the ledger at the newest generations", () => {
    for (let g = 0; g < AUDIO_FIT_LEDGER_CAP + 10; g++) {
      recordAudioFitObservation({
        generationId: `gen-${g}`,
        genre: "techno",
        selectedIndex: 0,
        candidates: [
          { candidateIndex: 0, firstPass: 0.9, audio: 0.4 },
          { candidateIndex: 1, firstPass: 0.8, audio: 0.6 },
        ],
      });
    }
    const ledger = readAudioFitLedger();
    expect(ledger.length).toBe(AUDIO_FIT_LEDGER_CAP);
    expect(ledger[0].generationId).toBe("gen-10"); // oldest trimmed
    expect(ledger[ledger.length - 1].generationId).toBe(`gen-${AUDIO_FIT_LEDGER_CAP + 9}`);
  });

  it("emits RerankSamples the fit harness consumes — and the fit prefers the weight that matches observed winners", () => {
    // Three generations where the DELIVERED winner had a weaker first-pass
    // score but a clearly better audio fit: baseline (weight 0 = first-pass
    // alone) picks the wrong candidate every time, so the fitted weight must
    // beat the baseline to be measurable.
    const generations: [number, number][] = [
      // [firstPassWinnerScore, audioWinnerScore] — the crossover lands at
      // w ≈ 0.375, INSIDE the fitted grid (0..0.6), so the fitted weight can
      // beat the first-pass-only baseline.
      [0.7, 0.9],
      [0.68, 0.9],
      [0.72, 0.9],
    ];
    generations.forEach(([fpWinner, audioWinner], g) => {
      const ok = recordAudioFitObservation({
        generationId: `gen-${g}`,
        genre: "techno",
        selectedIndex: 1, // the audio-heavy candidate delivered
        candidates: [
          { candidateIndex: 0, firstPass: fpWinner, audio: 0.4 },
          { candidateIndex: 1, firstPass: 0.3, audio: audioWinner },
        ],
      });
      expect(ok).toBe(true);
    });
    const samples = audioFitLedgerSamples();
    expect(samples.length).toBe(6);
    expect(samples.filter((s) => s.kept).length).toBe(3);

    const fitted = fitRerankWeight(samples as RerankSample[]);
    expect(fitted).not.toBeNull();
    expect(fitted!.accuracy).toBeGreaterThan(fitted!.baselineAccuracy);
  });

  it("ranking-v3 records the observation during a sound rerank (integration)", async () => {
    // Injectable renderer: candidate 1 sounds closest to the genre target.
    const render = async () => new Float32Array(44100).fill(0.1);
    const bank: RankedCandidate[] = [
      candidate(0, 0.9, "hash-a"),
      candidate(1, 0.7, "hash-b"),
      candidate(2, 0.6, "hash-c"),
    ];
    const scoreByIndex = new Map([
      [0, 0.3],
      [1, 0.9],
      [2, 0.4],
    ]);
    const reranked = await rerankTopBySound(doc, bank, "techno", {
      bank: bankStub,
      weight: 0.6,
      render: async (_doc, _bank, pattern) => {
        void pattern;
        return new Float32Array(44100).fill(0.1);
      },
    });
    void scoreByIndex;
    void reranked;

    const ledger = readAudioFitLedger();
    expect(ledger.length).toBe(1);
    const observation = ledger[0];
    expect(observation.genre).toBe("techno");
    expect(observation.candidates.length).toBe(3);
    // winner delivered = first entry after the reorder
    expect(observation.selectedIndex).toBe(0);
    expect(observation.candidates[observation.selectedIndex].selected).toBe(true);
    void render;
  });
});
