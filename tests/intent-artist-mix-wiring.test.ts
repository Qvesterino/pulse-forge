import { describe, expect, it } from "vitest";
import { ARTIST_MIX_PROFILES, artistMixProfileOf } from "../src/intent/artist-mix";
import {
  deepProfileToArtistMix,
  getArtistProfile,
  normalizeArtistSlug,
} from "../src/intent/artist-profiles";
import type { ArtistProfile } from "../src/intent/artist-profiles";
import { INTENT_SCHEMA_VERSION, type IntentSpec } from "../src/intent/types";

function baseIntent(artist: string | undefined): IntentSpec {
  return {
    version: INTENT_SCHEMA_VERSION,
    genre: "trap",
    style: null,
    productionProfile: undefined,
    artist,
    mood: null,
    energy: 0.5,
    density: 0.5,
    complexity: 0.5,
    variation: 0.5,
    seed: "test-seed",
    text: undefined,
    key: null,
    bpmRange: null,
    length: 60,
    candidateCount: undefined,
    symbolicCandidates: undefined,
    roles: ["drums", "bass"],
    preserve: undefined,
    targetTracks: { drumTrackId: null, instrumentTrackIds: [] },
    constraints: { preserveAnchors: false, allowGhosts: false, allowSwing: false },
    controls: { ghostWeight: 0.5, microWeight: 0.5, velocityVariation: 0.5, temperature: 0.5 },
    sourcePatternId: null,
    replaceMode: "replace",
    applyGrooveSettings: true,
    fx: null,
  };
}

describe("normalizeArtistSlug", () => {
  it("collapses parenthetical suffixes", () => {
    expect(normalizeArtistSlug("fred again (ukg)")).toBe("fred-again");
  });

  it("collapses forward-slash qualifiers", () => {
    expect(normalizeArtistSlug("skepta / grime")).toBe("skepta");
    expect(normalizeArtistSlug("burial / future garage")).toBe("burial");
  });

  it("strips periods and collapses whitespace", () => {
    expect(normalizeArtistSlug("dr. dre")).toBe("dr-dre");
    expect(normalizeArtistSlug("travis scott")).toBe("travis-scott");
  });

  it("passes through simple labels unchanged", () => {
    expect(normalizeArtistSlug("sophie")).toBe("sophie");
    expect(normalizeArtistSlug("kaytranada")).toBe("kaytranada");
  });
});

describe("artistMixProfileOf — curated layer (BC preserved)", () => {
  it("returns curated profile for 'travis scott' (dark tone)", () => {
    expect(artistMixProfileOf(baseIntent("travis scott"))?.tone).toBe("dark");
    expect(artistMixProfileOf(baseIntent("travis scott"))?.reverb).toBe("huge");
  });

  it("returns curated profile for 'dr. dre' (warm tone, more punch)", () => {
    expect(artistMixProfileOf(baseIntent("dr. dre"))?.tone).toBe("warm");
    expect(artistMixProfileOf(baseIntent("dr. dre"))?.punch).toBe("more");
  });

  it("returns curated profile for 'sophie' (bright, more punch, less reverb)", () => {
    const profile = artistMixProfileOf(baseIntent("sophie"));
    expect(profile?.tone).toBe("bright");
    expect(profile?.punch).toBe("more");
    expect(profile?.reverb).toBe("less");
  });

  it("returns null for unknown artist", () => {
    expect(artistMixProfileOf(baseIntent("nobody-in-anywhere"))).toBeNull();
  });

  it("returns null when intent.artist is absent", () => {
    expect(artistMixProfileOf(baseIntent(undefined))).toBeNull();
  });
});

describe("deepProfileToArtistMix — eqTilt → tone mapping", () => {
  function profileFixture(overrides: Partial<ArtistProfile>): ArtistProfile {
    return {
      slug: "fixture",
      name: "Fixture",
      genres: ["house"],
      signature: { sound: [], samples: [], bpm: { typical: [120, 130] }, keys: [] },
      mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" },
      master: { targetLufs: -8, tonalBalance: "balanced" },
      gear: [],
      vibe: [],
      sources: [],
      verificationStatus: "ai-inferred",
      lastUpdated: "2026-09-26",
      ...overrides,
    };
  }

  it("dark eqTilt → dark tone", () => {
    expect(deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "dark", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" } })).tone).toBe("dark");
  });

  it("bright eqTilt → bright tone", () => {
    expect(deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "bright", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" } })).tone).toBe("bright");
  });

  it("neutral eqTilt → warm tone (engine's closest producer-decision)", () => {
    expect(deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" } })).tone).toBe("warm");
  });
});

describe("deepProfileToArtistMix — compression → punch mapping", () => {
  function profileFixture(overrides: Partial<ArtistProfile>): ArtistProfile {
    return {
      slug: "fixture",
      name: "Fixture",
      genres: ["house"],
      signature: { sound: [], samples: [], bpm: { typical: [120, 130] }, keys: [] },
      mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" },
      master: { targetLufs: -8, tonalBalance: "balanced" },
      gear: [],
      vibe: [],
      sources: [],
      verificationStatus: "ai-inferred",
      lastUpdated: "2026-09-26",
      ...overrides,
    };
  }

  it("heavy compression → punch: more", () => {
    expect(deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "heavy", stereoWidth: "normal", subEmphasis: "moderate" } })).punch).toBe("more");
  });

  it("light compression → punch: less", () => {
    expect(deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "light", stereoWidth: "normal", subEmphasis: "moderate" } })).punch).toBe("less");
  });

  it("medium compression → punch: undefined (genre default wins)", () => {
    expect(deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" } })).punch).toBeUndefined();
  });
});

describe("deepProfileToArtistMix — vibe → reverb mapping", () => {
  function profileFixture(vibe: readonly string[]): ArtistProfile {
    return {
      slug: "fixture",
      name: "Fixture",
      genres: ["house"],
      signature: { sound: [], samples: [], bpm: { typical: [120, 130] }, keys: [] },
      mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" },
      master: { targetLufs: -8, tonalBalance: "balanced" },
      gear: [],
      vibe,
      sources: [],
      verificationStatus: "ai-inferred",
      lastUpdated: "2026-09-26",
    };
  }

  it("atmospheric/ethereal vibe → reverb: huge", () => {
    expect(deepProfileToArtistMix(profileFixture(["atmospheric", "transcendent"])).reverb).toBe("huge");
    expect(deepProfileToArtistMix(profileFixture(["ethereal", "cinematic"])).reverb).toBe("huge");
  });

  it("tight/club vibe → reverb: less", () => {
    expect(deepProfileToArtistMix(profileFixture(["tight", "forward"])).reverb).toBe("less");
    expect(deepProfileToArtistMix(profileFixture(["aggressive", "club"])).reverb).toBe("less");
  });
});

describe("deepProfileToArtistMix — pump detection", () => {
  function profileFixture(sound: readonly string[]): ArtistProfile {
    return {
      slug: "fixture",
      name: "Fixture",
      genres: ["house"],
      signature: { sound, samples: [], bpm: { typical: [120, 130] }, keys: [] },
      mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" },
      master: { targetLufs: -8, tonalBalance: "balanced" },
      gear: [],
      vibe: [],
      sources: [],
      verificationStatus: "ai-inferred",
      lastUpdated: "2026-09-26",
    };
  }

  it("sidechain keyword → pump: true", () => {
    expect(deepProfileToArtistMix(profileFixture(["sidechain pumping synth bass"])).pump).toBe(true);
  });

  it("no sidechain keyword → pump: undefined", () => {
    expect(deepProfileToArtistMix(profileFixture(["reese bass", "808 slide"])).pump).toBeUndefined();
  });
});

describe("artistMixProfileOf — deep profile fallback (Phase 2 wiring)", () => {
  it("travis-scott slug lookup returns dark tone (deep layer)", () => {
    // 'travis-scott' (slug form) is NOT in ARTIST_MIX_PROFILES (curated uses
    // 'travis scott' with a space). Fallback should hit deep layer.
    expect(ARTIST_MIX_PROFILES["travis-scott"]).toBeUndefined();
    const profile = artistMixProfileOf(baseIntent("travis-scott"));
    expect(profile?.tone).toBe("dark");
  });

  it("travis scott (curated form) wins over deep layer", () => {
    // 'travis scott' is in ARTIST_MIX_PROFILES — curated wins even if deep
    // would derive the same answer. Behavior must be unchanged.
    const profile = artistMixProfileOf(baseIntent("travis scott"));
    expect(profile?.tone).toBe("dark");
    expect(profile?.reverb).toBe("huge");
    expect(profile?.punch).toBe("more");
  });

  it("dr. dre (curated, warm) wins over deep layer (would derive warm too)", () => {
    expect(artistMixProfileOf(baseIntent("dr. dre"))?.tone).toBe("warm");
  });

  it("kaytranada (NOT in curated, in deep) falls back to deep layer", () => {
    expect(ARTIST_MIX_PROFILES["kaytranada"]).toBeUndefined();
    const profile = artistMixProfileOf(baseIntent("kaytranada"));
    expect(profile).not.toBeNull();
    // kaytranada's vibe includes 'lo-fi', 'soulful' — neither matches huge/less keywords
    // compression is medium → punch undefined. eqTilt is neutral → warm.
    expect(profile?.tone).toBe("warm");
  });

  it("axl-beats (NOT in curated, in deep) derives dark tone + more punch", () => {
    expect(ARTIST_MIX_PROFILES["axl-beats"]).toBeUndefined();
    const profile = artistMixProfileOf(baseIntent("axl-beats"));
    expect(profile?.tone).toBe("dark");
    expect(profile?.punch).toBe("more"); // compression: heavy
  });

  it("burial (curated as 'burial / future garage') uses curated entry", () => {
    // Curated entry exists for "burial / future garage" with dark tone, huge reverb
    const profile = artistMixProfileOf(baseIntent("burial / future garage"));
    expect(profile?.tone).toBe("dark");
    expect(profile?.reverb).toBe("huge");
  });

  it("burial (slug form, NOT in curated) falls back to deep layer", () => {
    expect(ARTIST_MIX_PROFILES["burial"]).toBeUndefined();
    const profile = artistMixProfileOf(baseIntent("burial"));
    expect(profile).not.toBeNull();
  });

  it("aphex-twin (deep only) derives neutral → warm tone", () => {
    expect(ARTIST_MIX_PROFILES["aphex-twin"]).toBeUndefined();
    const profile = artistMixProfileOf(baseIntent("aphex-twin"));
    expect(profile?.tone).toBe("warm");
  });
});

describe("artistMixProfileOf — round-trip with intent.artist", () => {
  it("the same 'travis scott' label produces stable decisions across calls", () => {
    // Phase 2 must not introduce non-determinism in planMixProfile's consumer.
    const a = artistMixProfileOf(baseIntent("travis scott"));
    const b = artistMixProfileOf(baseIntent("travis scott"));
    expect(a).toEqual(b);
  });

  it("deep profiles used by the deep layer are validated fixtures", () => {
    // Pin the canonical deep profiles used as fallback so a future edit
    // to a profile's mix traits surfaces in the test failure.
    expect(getArtistProfile("travis-scott")?.mix.eqTilt).toBe("dark");
    expect(getArtistProfile("kaytranada")?.mix.eqTilt).toBe("neutral");
    expect(getArtistProfile("axl-beats")?.mix.compression).toBe("heavy");
    expect(getArtistProfile("burial")?.mix.eqTilt).toBe("dark");
  });
});
