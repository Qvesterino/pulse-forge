import { describe, expect, it } from "vitest";
import { ARTIST_MIX_PROFILES, artistMixProfileOf } from "../src/intent/artist-mix";
import {
  deepProfileToArtistMix,
  getArtistProfile,
  normalizeArtistSlug,
} from "../src/intent/artist-profiles";
import type { ArtistProfile } from "../src/intent/artist-profiles";
import { INTENT_SCHEMA_VERSION, type IntentSpec } from "../src/intent/types";
import { planMixProfile } from "../src/intent/mix";

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

function profileFixture(overrides: Partial<ArtistProfile>): ArtistProfile {
  return {
    slug: "fixture",
    name: "Fixture",
    genres: ["trap"],
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

/* ---------------------------------------------------------------------------
 * Phase 2 slice 2 — width + sub mapping + planMixProfile decisions.
 * ------------------------------------------------------------------------- */

describe("deepProfileToArtistMix — stereoWidth → width mapping", () => {
  it("wide stereoWidth → width: wide", () => {
    expect(
      deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "wide", subEmphasis: "moderate" } }))
        .width,
    ).toBe("wide");
  });

  it("narrow stereoWidth → width: narrow", () => {
    expect(
      deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "narrow", subEmphasis: "moderate" } }))
        .width,
    ).toBe("narrow");
  });

  it("normal stereoWidth → width: undefined (genre default wins)", () => {
    expect(
      deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" } }))
        .width,
    ).toBeUndefined();
  });
});

describe("deepProfileToArtistMix — subEmphasis → sub mapping", () => {
  it("prominent subEmphasis → sub: prominent", () => {
    expect(
      deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "prominent" } }))
        .sub,
    ).toBe("prominent");
  });

  it("subtle subEmphasis → sub: subtle", () => {
    expect(
      deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "subtle" } }))
        .sub,
    ).toBe("subtle");
  });

  it("moderate subEmphasis → sub: undefined", () => {
    expect(
      deepProfileToArtistMix(profileFixture({ mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" } }))
        .sub,
    ).toBeUndefined();
  });
});

describe("planMixProfile — width wiring (Phase 2 slice 2)", () => {
  it("wide width pushes haasWidener decisions on chords + lead with width=0.85", () => {
    const intent = baseIntent(undefined);
    // Synthesize a deep profile with wide stereoWidth by routing through
    // artistMixProfileOf. Travis Scott has dark tone + reverb=huge (curated
    // wins), so we can't easily inject width via curated. Instead, test the
    // decision tree directly: an artist that has width="wide" via deep
    // fallback. Fred Again has stereoWidth="wide" in its deep profile.
    const intentWithArtist = baseIntent("fred-again");
    const profile = planMixProfile(intentWithArtist, {}, {});
    const haasDecisions = profile.decisions.filter((d) => d.effectType === "haasWidener");
    expect(haasDecisions.length).toBeGreaterThan(0);
    expect(haasDecisions.every((d) => d.params.width === 0.85)).toBe(true);
    expect(profile.summary.some((line) => line.startsWith("width: wide"))).toBe(true);
  });

  it("narrow width pushes haasWidener decisions with width=0.35", () => {
    // Drill (axl-beats) has stereoWidth="normal" in its deep profile so it
    // does NOT emit haasWidener. Use a profileFixture-like scenario via a
    // direct ArtistMixProfile call by simulating a narrow profile.
    // Since artistMixProfileOf already returns the deep-derived profile for
    // axl-beats, we need a fixture approach. Use Burial (narrowWidth — but
    // burial is "dark" tone, NOT narrow width). Use DJ Tameil — he has
    // "narrow" stereoWidth in his deep profile (punchy kick, tight stereo).
    const intentWithArtist = baseIntent("dj-tameil");
    const profile = planMixProfile(intentWithArtist, {}, {});
    const haasDecisions = profile.decisions.filter((d) => d.effectType === "haasWidener");
    expect(haasDecisions.length).toBeGreaterThan(0);
    expect(haasDecisions.every((d) => d.params.width === 0.35)).toBe(true);
    expect(profile.summary.some((line) => line.startsWith("width: narrow"))).toBe(true);
  });

  it("no width signal — no haasWidener decisions emitted", () => {
    const intent = baseIntent(undefined); // no artist, no width signal
    const profile = planMixProfile(intent, {}, {});
    const haasDecisions = profile.decisions.filter((d) => d.effectType === "haasWidener");
    expect(haasDecisions.length).toBe(0);
  });
});

describe("planMixProfile — sub wiring (Phase 2 slice 2)", () => {
  it("prominent sub pushes bass eq with lowShelfGain=+3.5", () => {
    // AXL Beats has subEmphasis="prominent" in deep profile (drill 808).
    const intentWithArtist = baseIntent("axl-beats");
    const profile = planMixProfile(intentWithArtist, {}, {});
    const subDecisions = profile.decisions.filter(
      (d) => d.target === "bass" && d.effectType === "eq" && d.params.lowShelfGain === 3.5,
    );
    expect(subDecisions.length).toBeGreaterThan(0);
    expect(profile.summary.some((line) => line.startsWith("sub: prominent"))).toBe(true);
  });

  it("subtle sub pushes bass eq with lowShelfGain=-1.5", () => {
    // Burial has subEmphasis="subtle" in deep profile.
    const intentWithArtist = baseIntent("burial");
    const profile = planMixProfile(intentWithArtist, {}, {});
    const subDecisions = profile.decisions.filter(
      (d) => d.target === "bass" && d.effectType === "eq" && d.params.lowShelfGain === -1.5,
    );
    expect(subDecisions.length).toBeGreaterThan(0);
    expect(profile.summary.some((line) => line.startsWith("sub: subtle"))).toBe(true);
  });

  it("no sub signal — no sub eq decision emitted", () => {
    const intent = baseIntent(undefined);
    const profile = planMixProfile(intent, {}, {});
    const subDecisions = profile.decisions.filter(
      (d) => d.target === "bass" && d.effectType === "eq" && d.params.lowShelfGain === 3.5,
    );
    expect(subDecisions.length).toBe(0);
  });
});

describe("planMixProfile — fixture pin (Phase 2 slice 2 deep profiles)", () => {
  // Pin the canonical deep profiles so a future edit to a profile's
  // mix traits surfaces in this test failure (the haasWidener / sub
  // wiring tests depend on these signals).
  it("AXL Beats has wide subEmphasis", () => {
    expect(getArtistProfile("axl-beats")?.mix.subEmphasis).toBe("prominent");
  });

  it("Burial has subtle subEmphasis", () => {
    expect(getArtistProfile("burial")?.mix.subEmphasis).toBe("subtle");
  });

  it("Fred Again has wide stereoWidth", () => {
    expect(getArtistProfile("fred-again")?.mix.stereoWidth).toBe("wide");
  });

  it("DJ Tameil has narrow stereoWidth", () => {
    expect(getArtistProfile("dj-tameil")?.mix.stereoWidth).toBe("narrow");
  });
});
