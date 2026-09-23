import { describe, it, expect } from "vitest";
import { rerankTopBySound } from "../src/intent/ranking-v3";
import type { RankedCandidate } from "../src/intent/types";
import type { Pattern } from "../src/project-model/types";
import type { SampleBank } from "../src/sample-library/factory";

/** 44.1 kHz mono PCM builders — a techno-ish thumpy kick bed vs quiet hiss. */
function kickishPcm(): Float32Array {
  const sampleRate = 44100;
  const pcm = new Float32Array(sampleRate * 2);
  const period = Math.round(sampleRate / 2); // 2 kicks per second
  for (let start = 0; start + 4000 < pcm.length; start += period) {
    for (let index = 0; index < 4000; index++) {
      const envelope = Math.exp(-index / 800);
      pcm[start + index] = 0.8 * envelope * Math.sin((2 * Math.PI * 90 * index) / sampleRate);
    }
  }
  return pcm;
}

function quietHissPcm(): Float32Array {
  const sampleRate = 44100;
  const pcm = new Float32Array(sampleRate * 2);
  let state = 12345;
  for (let index = 0; index < pcm.length; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    pcm[index] = ((state / 0x7fffffff) * 2 - 1) * 0.002;
  }
  return pcm;
}

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

const bank = {} as unknown as SampleBank;
const doc = {} as unknown as ProjectDocument;

import type { ProjectDocument } from "../src/project-model/types";

describe("ranking v3 — sound re-rank of the finalists", () => {
  const fit = kickishPcm();
  const misfit = quietHissPcm();
  const patternA = { rows: {} } as unknown as Pattern; // audio fit
  const patternB = { rows: { x: [1] } } as unknown as Pattern; // audio misfit
  const renderByPattern = new Map<Pattern, Float32Array>([
    [patternA, fit],
    [patternB, misfit],
  ]);
  const render = async (_doc: unknown, _bank: unknown, pattern: Pattern) => renderByPattern.get(pattern) ?? misfit;

  it("the audio misfit first-pass winner loses to the fitting finalist", async () => {
    // CLOSE first-pass scores (0.9 vs 0.85) — the realistic case where the audio check breaks the tie
    const input = [entry(0, 0.9, patternB), entry(1, 0.85, patternA), entry(2, 0.2, patternB)];
    const result = await rerankTopBySound(doc, input, "techno", {
      bank,
      finalists: 2,
      render: render as Parameters<typeof rerankTopBySound>[3]["render"],
    });
    expect(result[0].candidateIndex).toBe(1); // the fitting candidate wins
    expect(result[result.length - 1].candidateIndex).toBe(2); // below the finalists: unchanged
  });

  it("failing renders keep the first-pass order", async () => {
    const input = [entry(0, 0.9, patternB), entry(1, 0.85, patternA)];
    const result = await rerankTopBySound(doc, input, "techno", {
      bank,
      render: async () => {
        throw new Error("renderer down");
      },
    });
    expect(result.map((entry) => entry.candidateIndex)).toEqual([0, 1]);
  });

  it("weight 0 keeps the first-pass order even with a perfect fit", async () => {
    const input = [entry(0, 0.9, patternB), entry(1, 0.85, patternA)];
    const result = await rerankTopBySound(doc, input, "techno", {
      bank,
      weight: 0,
      render: render as Parameters<typeof rerankTopBySound>[3]["render"],
    });
    expect(result[0].candidateIndex).toBe(0);
  });

  it("finalists cap: candidates below the cut keep their positions", async () => {
    const patternC = { rows: { y: [1] } } as unknown as Pattern;
    const input = [entry(0, 0.9, patternB), entry(1, 0.5, patternA), entry(2, 0.1, patternC)];
    const result = await rerankTopBySound(doc, input, "techno", {
      bank,
      finalists: 2,
      render: render as Parameters<typeof rerankTopBySound>[3]["render"],
    });
    expect(result).toHaveLength(3);
    expect(result[2].candidateIndex).toBe(2);
  });
});
