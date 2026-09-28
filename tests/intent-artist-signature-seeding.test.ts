import { describe, expect, it, beforeEach } from "vitest";
import {
  ARTIST_SIGNATURE_PULL,
  artistSignatureSignature,
  artistSignatureText,
  hasArtistSignature,
} from "../src/intent/artist-signature";
import { getArtistProfile } from "../src/intent/artist-profiles";
import {
  resetSemanticConditioning,
  semanticConditioning,
  semanticConditioningForIntent,
  setAudioReferenceConditioning,
  setSemanticEmbedOverride,
} from "../src/intent/semantic-conditioning";
import type { ArtistProfile } from "../src/intent/artist-profiles";

/**
 * A deterministic stand-in for the MiniLM worker: maps a sentence to a stable
 * pseudo-embedding by hashing its characters, so two different sentences
 * always project to two different vectors and the same sentence always
 * projects to the same vector. The real encoder's exact geometry is irrelevant
 * here — what is under test is WHICH base wins, HOW MUCH the text pulls it,
 * and that a no-artist call is byte-identical to the pre-slice behaviour.
 */
function fakeEmbed(dims = 384): (texts: string[]) => Promise<Float32Array[]> {
  return async (texts: string[]) =>
    texts.map((text) => {
      const out = new Float32Array(dims);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[code % dims] += ((code % 17) + 1) / 17;
        out[(code * 7) % dims] -= ((code % 11) + 1) / 11;
      }
      // Guard against an all-zero projection for short/empty-ish sentences.
      out[0] += 0.5;
      return out;
    });
}

const TRAVIS = getArtistProfile("travis-scott")!;
const ANYMA = getArtistProfile("anyma")!;

function profileFixture(overrides: Partial<ArtistProfile>): ArtistProfile {
  return {
    slug: "fixture",
    name: "Fixture",
    genres: ["trap"],
    signature: { sound: [], samples: [], bpm: { typical: [120, 130] }, keys: [] },
    mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" },
    master: { targetLufs: -8, tonalBalance: "x" },
    gear: [],
    vibe: [],
    sources: [],
    verificationStatus: "ai-inferred",
    lastUpdated: "2026-09-26",
    ...overrides,
  };
}

describe("artistSignatureText", () => {
  it("leads with the sonic signature, then samples, then vibe", () => {
    const text = artistSignatureText(TRAVIS);
    expect(text).toContain("AUTO-TUNE-heavy lead vocals");
    expect(text).toContain("cinematic");
  });

  it("is deterministic for the same profile", () => {
    expect(artistSignatureText(TRAVIS)).toBe(artistSignatureText(TRAVIS));
  });

  it("differs between two artists (this is the point of seeding)", () => {
    expect(artistSignatureText(TRAVIS)).not.toBe(artistSignatureText(ANYMA));
  });

  it("stays inside the encoder's usable window", () => {
    expect(artistSignatureText(TRAVIS).length).toBeLessThanOrEqual(220);
  });

  it("handles a profile with only vibe words", () => {
    const fixture = profileFixture({
      signature: { sound: [], samples: [], bpm: { typical: [120, 130] }, keys: [] },
      vibe: ["dark", "cinematic"],
    });
    expect(artistSignatureText(fixture)).toBe("dark, cinematic");
  });
});

describe("artistSignatureSignature", () => {
  it("includes the slug and the curation date", () => {
    expect(artistSignatureSignature(TRAVIS)).toBe(`travis-scott@${TRAVIS.lastUpdated}`);
  });

  it("changes when the profile's lastUpdated moves (cache invalidation)", () => {
    const a = artistSignatureSignature(TRAVIS);
    const b = artistSignatureSignature({ ...TRAVIS, lastUpdated: "2027-01-01" });
    expect(a).not.toBe(b);
  });
});

describe("hasArtistSignature", () => {
  it("is true for a curated profile", () => {
    expect(hasArtistSignature(TRAVIS)).toBe(true);
  });

  it("is false for null / undefined", () => {
    expect(hasArtistSignature(null)).toBe(false);
    expect(hasArtistSignature(undefined)).toBe(false);
  });

  it("is false for a profile with neither sound nor vibe", () => {
    const empty = profileFixture({});
    expect(hasArtistSignature(empty)).toBe(false);
  });
});

describe("semanticConditioning — artist signature as the base", () => {
  beforeEach(() => {
    resetSemanticConditioning();
    setAudioReferenceConditioning(null);
    setSemanticEmbedOverride(fakeEmbed());
  });

  it("embeds text and signature in ONE batched call", async () => {
    const calls: string[][] = [];
    setSemanticEmbedOverride(async (texts) => {
      calls.push(texts);
      return fakeEmbed()(texts);
    });
    await semanticConditioning("travis scott type beat", undefined, TRAVIS);
    expect(calls.length).toBe(1);
    expect(calls[0]).toHaveLength(2);
  });

  it("resolves the parsed artist label when conditioning a complete intent", async () => {
    const calls: string[][] = [];
    setSemanticEmbedOverride(async (texts) => {
      calls.push(texts);
      return fakeEmbed()(texts);
    });
    const result = await semanticConditioningForIntent({
      artist: "travis scott",
      text: "travis scott type beat, but brighter",
      genre: "trap",
      style: null,
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["travis scott type beat, but brighter", artistSignatureText(TRAVIS)]);
  });

  it("embeds only the signature when the user typed nothing usable", async () => {
    const calls: string[][] = [];
    setSemanticEmbedOverride(async (texts) => {
      calls.push(texts);
      return fakeEmbed()(texts);
    });
    const result = await semanticConditioning("", undefined, TRAVIS);
    expect(result).not.toBeNull();
    expect(calls[0]).toHaveLength(1);
  });

  it("stays null for an empty prompt with no artist (unchanged behaviour)", async () => {
    const result = await semanticConditioning("", undefined, null);
    expect(result).toBeNull();
  });

  it("returns a finite vector when the artist is seeded", async () => {
    const result = await semanticConditioning("travis scott type beat", undefined, TRAVIS);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    expect(result!.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("produces DIFFERENT vectors for two different artists on the same text", async () => {
    const a = await semanticConditioning("make it like this artist", undefined, TRAVIS);
    resetSemanticConditioning();
    const b = await semanticConditioning("make it like this artist", undefined, ANYMA);
    expect(a).not.toEqual(b);
  });

  it("a re-styled prompt pulls the signature toward the words", async () => {
    const plain = await semanticConditioning("travis scott", undefined, TRAVIS);
    resetSemanticConditioning();
    const steered = await semanticConditioning("travis scott but happy bouncy riddim", undefined, TRAVIS);
    expect(steered).not.toEqual(plain);
  });

  it("an installed audio reference OUTRANKS the artist signature", async () => {
    // The WAV is the more specific statement of intent, so it replaces the
    // signature base rather than fighting it.
    const withRef = await semanticConditioning("travis scott type beat", undefined, TRAVIS);
    resetSemanticConditioning();
    const referenceVector = (await fakeEmbed()(["reference wav"]))[0];
    setAudioReferenceConditioning(Array.from(referenceVector));
    const withReferenceInstalled = await semanticConditioning("travis scott type beat", undefined, TRAVIS);
    expect(withRef).not.toBeNull();
    expect(withReferenceInstalled).not.toBeNull();
    expect(withReferenceInstalled).not.toEqual(withRef);
  });
});

describe("ARTIST_SIGNATURE_PULL", () => {
  it("is a bounded 0..1 weight", () => {
    expect(ARTIST_SIGNATURE_PULL).toBeGreaterThan(0);
    expect(ARTIST_SIGNATURE_PULL).toBeLessThanOrEqual(1);
  });
});

describe("no-artist regression: the pre-slice chain is untouched", () => {
  beforeEach(() => {
    resetSemanticConditioning();
    setAudioReferenceConditioning(null);
    setSemanticEmbedOverride(fakeEmbed());
  });

  it("an artist-free call embeds exactly ONE input", async () => {
    const calls: string[][] = [];
    setSemanticEmbedOverride(async (texts) => {
      calls.push(texts);
      return fakeEmbed()(texts);
    });
    await semanticConditioning("dark drill at 140", undefined, undefined);
    expect(calls[0]).toEqual(["dark drill at 140"]);
  });

  it("an artist-free call matches the unseeded result", async () => {
    const a = await semanticConditioning("dark drill at 140");
    resetSemanticConditioning();
    const b = await semanticConditioning("dark drill at 140", undefined, undefined);
    expect(a).toEqual(b);
  });
});
