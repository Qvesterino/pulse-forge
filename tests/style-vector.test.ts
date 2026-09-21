import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  INTENT_BLEND_WEIGHT,
  blendSemantic,
  computeStyleVector,
  resetStyleVector,
  styleVectorMode,
  styleVectorSignature,
  styleVectorTextForEntry,
} from "../src/intent/style-vector";
import { resetSemanticConditioning, semanticConditioning } from "../src/intent/semantic-conditioning";
import { readFavoriteLedger, recordFavoriteLedgerEntry, FAVORITES_LEDGER_KEY } from "../src/intent/favorites";
import type { FavoriteLedgerEntry } from "../src/intent/favorites-core";
import { projectEmbedding } from "../src/ai/symbolic/pca-projection";

// The semantic WORKER is the real MiniLM runtime — stub the embed call with a
// deterministic per-text vector so blends/projections are numerically checkable.
vi.mock("../src/ai/semantic/semantic-client", () => ({
  semanticMode: vi.fn(() => "on" as const),
  semanticAvailable: vi.fn(async () => true),
  embedTexts: vi.fn(async () => null),
  resetSemanticClient: vi.fn(),
}));

import { embedTexts } from "../src/ai/semantic/semantic-client";

const embedTextsMock = vi.mocked(embedTexts);

function makeEntry(overrides: Partial<FavoriteLedgerEntry> = {}): FavoriteLedgerEntry {
  return {
    savedAt: 1_700_000_000_000,
    seed: "seed-1",
    genre: "house",
    grooveId: "house.deep",
    energy: 0.8,
    density: 0.5,
    complexity: 0.5,
    variation: 0.3,
    padIds: ["pad-1"],
    padNames: ["Kick"],
    rows: { "pad-1": [1, 0, 0, 0] },
    ...overrides,
  };
}

/** Deterministic pseudo-embedding per text (FNV-chained) — stable across runs. */
function vectorFor(text: string): Float32Array {
  const out = new Float32Array(384);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  for (let index = 0; index < 384; index++) {
    hash = Math.imul(hash ^ (index + 1), 16777619);
    out[index] = ((hash >>> 0) / 0xffffffff) * 2 - 1;
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
  resetStyleVector();
  resetSemanticConditioning();
  embedTextsMock.mockReset();
  embedTextsMock.mockResolvedValue(null);
});

afterEach(() => {
  localStorage.clear();
  resetStyleVector();
  resetSemanticConditioning();
});

describe("style vector text + signature", () => {
  it("projects an entry into a deterministic EN corpus-style text", () => {
    const text = styleVectorTextForEntry(makeEntry());
    expect(text).toContain("house");
    expect(text).toContain("deep");
    expect(text).toContain("energetic");
    expect(text).toBe(styleVectorTextForEntry(makeEntry()));
    // style tokens with dashes/spaces normalize
    expect(styleVectorTextForEntry(makeEntry({ grooveId: "trap.bouncy-808" }))).toContain("bouncy 808");
  });

  it("signature is stable per ledger and changes when rolls change", () => {
    const entries = [makeEntry(), makeEntry({ savedAt: 2, seed: "seed-2", grooveId: "techno.driving" })];
    expect(styleVectorSignature(entries)).toBe(styleVectorSignature([...entries].reverse()));
    const before = styleVectorSignature(entries);
    const after = styleVectorSignature([...entries, makeEntry({ savedAt: 3, seed: "seed-3" })]);
    expect(after).not.toBe(before);
  });
});

describe("blendSemantic", () => {
  it("is the alpha-weighted mix with INTENT_BLEND_WEIGHT dominant", () => {
    expect(INTENT_BLEND_WEIGHT).toBe(0.75);
    const mixed = blendSemantic([1, 0], [0, 1]);
    expect(mixed[0]).toBeCloseTo(0.75);
    expect(mixed[1]).toBeCloseTo(0.25);
  });
});

describe("computeStyleVector", () => {
  it("averages the roll embeddings then projects once; cached per signature", async () => {
    const e1 = makeEntry();
    const e2 = makeEntry({
      savedAt: 2,
      seed: "seed-2",
      genre: "techno",
      grooveId: "techno.driving",
      energy: 0.3,
    });
    embedTextsMock.mockImplementation(async (texts: string[]) => texts.map(vectorFor));

    const style = await computeStyleVector([e1, e2], embedTextsMock);
    expect(style).not.toBeNull();
    expect(style?.length).toBe(16);
    expect(style?.every((value) => Number.isFinite(value))).toBe(true);
    // exact same arithmetic: mean in 384-dim → one PCA projection
    const mean = new Float64Array(384);
    const v1 = vectorFor(styleVectorTextForEntry(e1));
    const v2 = vectorFor(styleVectorTextForEntry(e2));
    for (let index = 0; index < 384; index++) mean[index] = (v1[index] + v2[index]) / 2;
    expect(style).toEqual(projectEmbedding(mean));

    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    // unchanged ledger → localStorage cache hit, no re-embed
    await computeStyleVector([e1, e2], embedTextsMock);
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    // changed ledger → new signature → re-embed
    await computeStyleVector([e1, e2, makeEntry({ savedAt: 3, seed: "seed-3" })], embedTextsMock);
    expect(embedTextsMock).toHaveBeenCalledTimes(2);
  });

  it("flag off → null without embedding; empty ledger → null", async () => {
    localStorage.setItem("pf:style-vector", "off");
    expect(await computeStyleVector([makeEntry()], embedTextsMock)).toBeNull();
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(await computeStyleVector([], embedTextsMock)).toBeNull();
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("unavailable embedder → null", async () => {
    expect(await computeStyleVector([makeEntry()], embedTextsMock)).toBeNull();
    expect(styleVectorMode()).toBe("on"); // default on — gated by the ledger, not the flag
  });
});

describe("semanticConditioning integration", () => {
  it("blends the style vector into the conditioning; flag off restores pure intent", async () => {
    localStorage.setItem("pf:embedding-conditioned", "on");
    recordFavoriteLedgerEntry(makeEntry());
    embedTextsMock.mockImplementation(async (texts: string[]) => texts.map(vectorFor));

    const prompt = "dark rainy berlin techno";
    const conditioning = await semanticConditioning(prompt, embedTextsMock);
    const pure = projectEmbedding(vectorFor(prompt)) as number[];
    const style = (await computeStyleVector(readFavoriteLedger(), embedTextsMock)) as number[];
    expect(conditioning).toEqual(blendSemantic(pure, style));

    // style-vector off → pure intent projection again (cache key changed)
    localStorage.setItem("pf:style-vector", "off");
    resetSemanticConditioning();
    const pureConditioning = await semanticConditioning(prompt, embedTextsMock);
    expect(pureConditioning).toEqual(pure);
  });

  it("empty ledger → identical to pure intent conditioning", async () => {
    localStorage.setItem("pf:embedding-conditioned", "on");
    embedTextsMock.mockImplementation(async (texts: string[]) => texts.map(vectorFor));
    expect(readFavoriteLedger()).toEqual([]);
    expect(localStorage.getItem(FAVORITES_LEDGER_KEY)).toBeNull();
    const conditioning = await semanticConditioning("deep house", embedTextsMock);
    expect(conditioning).toEqual(projectEmbedding(vectorFor("deep house")));
  });
});
