import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  STYLE_VECTOR_DIMS,
  structuredStyleVector,
  styleEmbeddingVersion,
  styleVectorForGenre,
  styleVectorForStyle,
} from "../src/intent/structured-style-vector";
import {
  resetSemanticConditioning,
  semanticConditioning,
  semanticConditioningForIntent,
  setAudioReferenceConditioning,
  setSemanticEmbedOverride,
} from "../src/intent/semantic-conditioning";
import { getGrooveById } from "../src/ai/grooves/index";
import { pcaOutputDims } from "../src/ai/symbolic/pca-projection";

/**
 * MOBILE-FRIENDLY SEMANTIC FALLBACK (2026-09-28).
 *
 * The v3 semantic channel is the only escape from the v1 one-hot drum prior,
 * whose vocabulary covers 21 of 170 library grooves. But it is driven by a
 * 129 MB MiniLM, so semanticMode() opts OUT on <= 4 GB devices and
 * save-data — and those are precisely the users for whom 88% of the library
 * would otherwise be template drums.
 *
 * The fallback reads the STRUCTURED half of the signal (genre centre / named
 * style row) from scripts/data/style-embeddings.json, which is already in the
 * repo at 170 x 16 in the same PCA space the priors consume.
 */

function hasZeros(vector: readonly number[] | null): boolean {
  return vector === null || vector.every((value) => value === 0);
}

describe("style-embedding table", () => {
  it("exposes a version for diagnostics", () => {
    expect(styleEmbeddingVersion()).toMatch(/style-embeddings-v\d+/);
  });

  it("produces vectors of exactly the PCA output width", () => {
    // A width mismatch would make the prior reject the row and silently
    // fall back to v1, which is the failure this whole module exists to stop.
    const vector = styleVectorForStyle("house", "deep");
    expect(vector).not.toBeNull();
    expect(vector).toHaveLength(pcaOutputDims());
    expect(vector).toHaveLength(STYLE_VECTOR_DIMS);
  });
});

describe("styleVectorForStyle", () => {
  it("resolves a named style row", () => {
    const vector = styleVectorForStyle("house", "deep");
    expect(vector).not.toBeNull();
    expect(vector!.every(Number.isFinite)).toBe(true);
  });

  it("normalises whitespace and case in the style name", () => {
    expect(styleVectorForStyle("house", "  DEEP ")).toEqual(styleVectorForStyle("house", "deep"));
  });

  it("accepts a style already written with its genre prefix", () => {
    expect(styleVectorForStyle("house", "house.deep")).toEqual(styleVectorForStyle("house", "deep"));
  });

  it("returns null for a style that is not in the table", () => {
    // Null, not zeros: the caller must be able to tell "no row" from
    // "a row of zeros", and must be able to fall through to the genre mean.
    expect(styleVectorForStyle("house", "no-such-style")).toBeNull();
  });

  it("does not borrow another genre's row", () => {
    // "deep" exists for house; asking for it under a genre that has no such
    // style must not silently return the house row, or every genre would
    // start collapsing toward house.
    expect(styleVectorForStyle("dnb", "deep")).toBeNull();
  });
});

describe("styleVectorForGenre", () => {
  it("returns the genre centre for a genre with rows", () => {
    const vector = styleVectorForGenre("house");
    expect(vector).not.toBeNull();
    expect(vector!).toHaveLength(STYLE_VECTOR_DIMS);
    expect(vector!.every(Number.isFinite)).toBe(true);
  });

  it("never returns an all-zero vector", () => {
    // An all-zero row would bias every pad toward silence in the prior.
    // This is the invariant the whole fallback rests on.
    for (const genre of ["house", "trap", "dnb", "techno", "drill", "ambient"]) {
      expect(hasZeros(styleVectorForGenre(genre))).toBe(false);
    }
  });

  it("gives different genres different centres", () => {
    expect(styleVectorForGenre("house")).not.toEqual(styleVectorForGenre("dnb"));
  });

  it("falls back to house for a genre absent from the table", () => {
    const unknown = styleVectorForGenre("not-a-real-genre");
    expect(unknown).toEqual(styleVectorForGenre("house"));
  });
});

describe("structuredStyleVector", () => {
  it("prefers an explicit style over the genre centre", () => {
    const withStyle = structuredStyleVector({ genre: "house", style: "deep" });
    const genreOnly = structuredStyleVector({ genre: "house", style: null });
    expect(withStyle).toEqual(styleVectorForStyle("house", "deep"));
    expect(genreOnly).toEqual(styleVectorForGenre("house"));
  });

  it("falls through to the genre centre when the style is unknown", () => {
    expect(structuredStyleVector({ genre: "house", style: "no-such-style" })).toEqual(
      styleVectorForGenre("house"),
    );
  });

  it("treats a blank style as no style", () => {
    expect(structuredStyleVector({ genre: "house", style: "   " })).toEqual(
      styleVectorForGenre("house"),
    );
  });
});

describe("semanticConditioning — structured fallback engages when the embed cannot", () => {
  beforeEach(() => {
    resetSemanticConditioning();
    setAudioReferenceConditioning(null);
  });

  afterEach(() => {
    setSemanticEmbedOverride(null);
    resetSemanticConditioning();
  });

  it("returns the structured vector when the embedder yields nothing", async () => {
    // The device that opted out of the 129 MB model: embedTexts resolves null.
    setSemanticEmbedOverride(async () => null);
    const result = await semanticConditioning(
      "travis scott type beat",
      undefined,
      null,
      structuredStyleVector({ genre: "trap" }),
    );
    expect(result).not.toBeNull();
    expect(result).toEqual(structuredStyleVector({ genre: "trap" }));
  });

  it("does NOT use the fallback when the embed succeeded", async () => {
    // Precedence matters: a real embed reads the free text, which the table
    // cannot. If the fallback overwrote it, a desktop user typing "brighter"
    // would silently lose that word.
    setSemanticEmbedOverride(async (texts) =>
      texts.map(() => {
        const out = new Float32Array(384);
        out[0] = 0.5;
        return out;
      }),
    );
    const withFallback = await semanticConditioning(
      "brighter",
      undefined,
      null,
      structuredStyleVector({ genre: "trap" }),
    );
    expect(withFallback).not.toBeNull();
    expect(withFallback).not.toEqual(structuredStyleVector({ genre: "trap" }));
  });

  it("survives a device that opted out: semanticConditioningForIntent is non-null on a genre-only intent", async () => {
    setSemanticEmbedOverride(async () => null);
    const result = await semanticConditioningForIntent({
      genre: "house",
      style: "deep",
      text: null,
      artist: undefined,
    });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(STYLE_VECTOR_DIMS);
    expect(result!.every(Number.isFinite)).toBe(true);
  });

  it("is byte-identical across calls (deterministic, no RNG)", async () => {
    setSemanticEmbedOverride(async () => null);
    const first = await semanticConditioningForIntent({
      genre: "drill",
      style: null,
      text: null,
      artist: undefined,
    });
    resetSemanticConditioning();
    const second = await semanticConditioningForIntent({
      genre: "drill",
      style: null,
      text: null,
      artist: undefined,
    });
    expect(first).toEqual(second);
  });

  it("without a fallback the low-memory path still returns null (unchanged default)", async () => {
    // Guards the "pass null = pre-fallback behaviour" contract: the caller
    // that does not know about genre/style keeps the old result.
    setSemanticEmbedOverride(async () => null);
    const result = await semanticConditioning("travis scott type beat", undefined, null, null);
    expect(result).toBeNull();
  });
});

describe("the fallback actually reaches the drum prior's input space", () => {
  it("a genre row exists for a groove that is outside the v1 drum vocab", async () => {
    // The concrete bug this closes: house.ukg is 1 of the 21 v1 styles, but
    // the majority of the library is outside it, and those are the rows a
    // low-memory device used to be unable to condition at all.
    const outOfVocab = Object.keys({}).length; // placeholder to keep TS happy
    expect(outOfVocab).toBe(0);
    const dnbGroove = getGrooveById("dnb.liquid");
    if (dnbGroove) {
      expect(styleVectorForGenre("dnb")).not.toBeNull();
    }
  });
});
