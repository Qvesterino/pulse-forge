import { describe, it, expect, beforeEach } from "vitest";
import {
  buildSemanticCorpus,
  semanticIntentFor,
  resetSemanticCorpusCache,
  SEMANTIC_THRESHOLD,
} from "../src/intent/semantic";
import { GENRES } from "../src/ai/types";

/**
 * Unit tests run with an INJECTED mock embedder — no network, no model.
 * The mock maps known vocabulary to genre-clustered vectors (deterministic),
 * so kNN behavior is precise. The REAL model is validated end-to-end by
 * scripts/smoke-semantic.mts.
 */

/** Deterministic 4-dim "embedding": genre word → one-hot-ish cluster vector. */
const GENRE_VECTOR: Record<string, number[]> = {
  techno: [0.98, 0.05, 0.02, 0.01],
  house: [0.02, 0.98, 0.03, 0.01],
  trap: [0.03, 0.02, 0.97, 0.02],
  ambient: [0.01, 0.04, 0.02, 0.97],
};

function mockEmbed(texts: string[]): Promise<Float32Array[] | null> {
  const out = texts.map((text) => {
    const normalized = text.toLowerCase();
    // query texts get a genre signal from a leading genre-ish word or the
    // corpus entry's own patch text
    const genre =
      (/\btechno\b/.test(normalized) && "techno") ||
      (/\bhouse\b|\bgroove\b/.test(normalized) && "house") ||
      (/\btrap\b|\b808\b/.test(normalized) && "trap") ||
      (/\bambient\b|\bsoundscape\b|\bdrone\b/.test(normalized) && "ambient");
    const vector = new Float32Array(4).fill(0.05);
    if (genre) {
      const base = GENRE_VECTOR[genre];
      for (let i = 0; i < 4; i++) vector[i] = base[i];
    }
    const norm = Math.hypot(...vector) || 1;
    return Float32Array.from(vector, (v) => v / norm);
  });
  return Promise.resolve(out);
}

beforeEach(() => {
  resetSemanticCorpusCache();
});

describe("semantic corpus (T1 krok 2)", () => {
  it("covers every artist preset and both languages", () => {
    const corpus = buildSemanticCorpus();
    expect(corpus.length).toBeGreaterThan(60);
    expect(corpus.some((entry) => entry.text.includes("travis scott"))).toBe(true);
    expect(corpus.some((entry) => entry.text.includes("metro boomin"))).toBe(true);
    expect(corpus.some((entry) => /tmav/.test(entry.text))).toBe(true); // SK paraphrase
  });

  it("patches only use canonical vocabulary", () => {
    for (const entry of buildSemanticCorpus()) {
      if (entry.patch.genre) expect(GENRES).toContain(entry.patch.genre);
      for (const key of ["energy", "density"] as const) {
        const value = entry.patch[key];
        if (value !== undefined) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("semanticIntentFor with injected embedder", () => {
  it("resolves the nearest genre cluster and returns its patch", async () => {
    const match = await semanticIntentFor("hard techno banger", { embed: mockEmbed });
    expect(match).not.toBeNull();
    expect(match!.input.genre).toBe("techno");
    expect(match!.score).toBeGreaterThanOrEqual(SEMANTIC_THRESHOLD);
  });

  it("trap query lands on trap references (artist entries included)", async () => {
    const match = await semanticIntentFor("trap 808 banger", { embed: mockEmbed });
    expect(match!.input.genre).toBe("trap");
  });

  it("returns null below the confidence threshold", async () => {
    // a vector pointing nowhere near any corpus cluster
    const nullEmbed = () => Promise.resolve([Float32Array.from([0.7, 0.7, 0.7, 0.05])]);
    expect(await semanticIntentFor("something unclassifiable", { embed: nullEmbed })).toBeNull();
  });

  it("embedder failure resolves null (keyword fallback stays intact)", async () => {
    const failingEmbed = () => Promise.resolve(null);
    expect(await semanticIntentFor("anything", { embed: failingEmbed })).toBeNull();
  });

  it("corpus embeddings are cached across calls", async () => {
    let calls = 0;
    const countingEmbed = async (texts: string[]) => {
      calls += 1;
      return mockEmbed(texts);
    };
    await semanticIntentFor("hard techno", { embed: countingEmbed });
    const afterFirst = calls;
    await semanticIntentFor("techno 808", { embed: countingEmbed });
    // second call only embeds the QUERY (one more call), not the corpus
    expect(calls).toBe(afterFirst + 1);
  });
});
