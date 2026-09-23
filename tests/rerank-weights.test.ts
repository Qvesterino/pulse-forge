import { describe, it, expect, beforeEach } from "vitest";
import {
  fitRerankWeight,
  readLearnedRerankWeight,
  RERANK_WEIGHTS_STORAGE_KEY,
  type RerankSample,
} from "../src/intent/rerank-weights";
import { rerankTopBySound } from "../src/intent/ranking-v3";
import type { RankedCandidate } from "../src/intent/types";
import type { Pattern } from "../src/project-model/types";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";

function sample(generationId: string, firstPass: number, audio: number, kept: boolean): RerankSample {
  return { generationId, firstPass, audio, kept };
}

describe("fitRerankWeight (pure grid search)", () => {
  it("audio-decided generations push the weight up with perfect accuracy", () => {
    // kept candidate LOSES on first pass but WINS on audio — only a high weight picks it
    const samples = [
      sample("g1", 0.9, 0.2, false),
      sample("g1", 0.3, 0.95, true),
      sample("g2", 0.8, 0.15, false),
      sample("g2", 0.4, 0.9, true),
    ];
    const fitted = fitRerankWeight(samples);
    expect(fitted).not.toBeNull();
    expect(fitted?.weight).toBeGreaterThan(0.3);
    expect(fitted?.accuracy).toBe(1);
    expect(fitted?.baselineAccuracy).toBeLessThan(1);
  });

  it("first-pass-decided generations keep the weight at zero", () => {
    const samples = [
      sample("g1", 0.95, 0.9, true),
      sample("g1", 0.3, 0.95, false),
      sample("g2", 0.9, 0.8, true),
      sample("g2", 0.2, 0.99, false),
    ];
    const fitted = fitRerankWeight(samples);
    expect(fitted?.weight).toBe(0);
    expect(fitted?.accuracy).toBe(1);
  });

  it("needs at least two generations", () => {
    const samples = [sample("g1", 0.9, 0.2, false), sample("g1", 0.3, 0.95, true)];
    expect(fitRerankWeight(samples)).toBeNull();
    expect(fitRerankWeight([])).toBeNull();
  });
});

describe("readLearnedRerankWeight (localStorage)", () => {
  beforeEach(() => {
    localStorage.removeItem(RERANK_WEIGHTS_STORAGE_KEY);
  });

  it("round-trips a valid fitted weight", () => {
    localStorage.setItem(
      RERANK_WEIGHTS_STORAGE_KEY,
      JSON.stringify({
        weight: 0.45,
        source: "learned-v1",
        fittedAt: "now",
        accuracy: 0.8,
        generations: 5,
        samples: 20,
      }),
    );
    expect(readLearnedRerankWeight()).toBe(0.45);
  });

  it("rejects garbage, out-of-range and missing entries", () => {
    expect(readLearnedRerankWeight()).toBeNull();
    localStorage.setItem(RERANK_WEIGHTS_STORAGE_KEY, "not json at all");
    expect(readLearnedRerankWeight()).toBeNull();
    localStorage.setItem(RERANK_WEIGHTS_STORAGE_KEY, JSON.stringify({ weight: 0.95 }));
    expect(readLearnedRerankWeight()).toBeNull(); // > MAX_RERANK_WEIGHT
  });
});

describe("ranking-v3 consumes the learned weight", () => {
  const bank = {} as unknown as SampleBank;
  const doc = {} as unknown as ProjectDocument;
  const patternA = { rows: {} } as unknown as Pattern; // audio fit
  const patternB = { rows: { x: [1] } } as unknown as Pattern; // audio misfit
  // kick-ish bed (in techno target ranges) vs quiet hiss (out of range) — a
  // BIG audio contrast so the learned weight has something to work with
  const render = async (_doc: unknown, _bank: unknown, pattern: Pattern) => {
    const sampleRate = 44100;
    const pcm = new Float32Array(sampleRate * 2);
    if (pattern === patternA) {
      const period = Math.round(sampleRate / 2);
      for (let start = 0; start + 4000 < pcm.length; start += period) {
        for (let index = 0; index < 4000; index++) {
          pcm[start + index] = 0.8 * Math.exp(-index / 800) * Math.sin((2 * Math.PI * 90 * index) / sampleRate);
        }
      }
      // hat ticks — bright transients so the ZCR dimension lands in range too
      const hatPeriod = Math.round(sampleRate / 4);
      for (let start = hatPeriod; start + 800 < pcm.length; start += hatPeriod) {
        for (let index = 0; index < 800; index++) {
          const state = (index * 2654435761) % 4294967296;
          pcm[start + index] += 0.35 * (((state >>> 9) % 2000) / 1000 - 1);
        }
      }
    } else {
      let state = 12345;
      for (let index = 0; index < pcm.length; index++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        pcm[index] = ((state / 0x7fffffff) * 2 - 1) * 0.002;
      }
    }
    return pcm;
  };

  function entry(index: number, score: number, pattern: Pattern): RankedCandidate {
    return {
      candidateIndex: index,
      seed: `seed-${index}`,
      source: "template",
      status: "accepted",
      repairs: [],
      score,
      modelScore: null,
      contentHash: `hash-${index}`,
      pattern,
    };
  }

  it("a learned weight CAN flip a race the default 0.3 would not", async () => {
    localStorage.setItem(
      RERANK_WEIGHTS_STORAGE_KEY,
      JSON.stringify({
        weight: 0.55,
        source: "learned-v1",
        fittedAt: "now",
        accuracy: 0.9,
        generations: 4,
        samples: 16,
      }),
    );
    // first pass 0.9 vs 0.5: at 0.3 the ranker wins, at 0.55 the audio fit flips it
    const input = [entry(0, 0.9, patternB), entry(1, 0.5, patternA)];
    const result = await rerankTopBySound(doc, input, "techno", { bank, render });
    expect(result[0].candidateIndex).toBe(1);
  });

  it("no learned entry → shipped default 0.3 keeps the ranker dominant", async () => {
    localStorage.removeItem(RERANK_WEIGHTS_STORAGE_KEY);
    const input = [entry(0, 0.9, patternB), entry(1, 0.5, patternA)];
    const result = await rerankTopBySound(doc, input, "techno", { bank, render });
    expect(result[0].candidateIndex).toBe(0);
  });
});
