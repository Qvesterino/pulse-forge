import { describe, expect, it } from "vitest";
import {
  artistBpmHint,
  artistHalfTimeHint,
  artistKeyCandidates,
  artistKeyHint,
  hasArtistSignature,
} from "../src/intent/artist-signature";
import { deepProfileToArtistMix, getArtistProfile } from "../src/intent/artist-profiles";
import { planMixProfile } from "../src/intent/mix";
import { planGeneration } from "../src/intent/plan";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { INTENT_SCHEMA_VERSION, type IntentSpec } from "../src/intent/types";
import type { ArtistProfile } from "../src/intent/artist-profiles";

function baseIntent(overrides: Partial<IntentSpec> = {}): IntentSpec {
  return {
    version: INTENT_SCHEMA_VERSION,
    genre: "trap",
    style: null,
    productionProfile: undefined,
    artist: undefined,
    mood: null,
    energy: 0.5,
    density: 0.5,
    complexity: 0.5,
    variation: 0.5,
    seed: "plan-hint-seed",
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
    ...overrides,
  };
}

function profileFixture(master: ArtistProfile["master"]): ArtistProfile {
  return {
    slug: "fixture",
    name: "Fixture",
    genres: ["trap"],
    signature: { sound: [], samples: [], bpm: { typical: [120, 130] }, keys: [] },
    mix: { eqTilt: "neutral", compression: "medium", stereoWidth: "normal", subEmphasis: "moderate" },
    master,
    gear: [],
    vibe: [],
    sources: [],
    verificationStatus: "ai-inferred",
    lastUpdated: "2026-09-26",
  };
}

/* -------------------------------------------------------------------- */
/* master.tonalBalance -> scoop (Phase 2 slice 5)                         */
/* -------------------------------------------------------------------- */

describe("deepProfileToArtistMix — tonalBalance -> scoop", () => {
  it('"scooped" in the descriptor engages the low-mid notch', () => {
    const derived = deepProfileToArtistMix(
      profileFixture({ targetLufs: -7, tonalBalance: "sub-heavy, scooped low-mids, dark overall" }),
    );
    expect(derived.scoop).toBe(true);
  });

  it("a descriptor with no scoop leaves it alone", () => {
    const derived = deepProfileToArtistMix(
      profileFixture({ targetLufs: -7, tonalBalance: "bright, present mids, airy highs" }),
    );
    expect(derived.scoop).toBeUndefined();
  });
});

describe("planMixProfile — scoop decision (Phase 2 slice 5)", () => {
  it("a scooped artist gets a low-mid peaking cut on chords + lead", () => {
    // AXL Beats' descriptor names a scooped 200-500 Hz balance; the notch
    // must be a real decision on the melodic tracks.
    const profile = planMixProfile(baseIntent({ artist: "axl-beats" }), {}, {});
    const scoops = profile.decisions.filter(
      (d) => d.effectType === "eq" && d.params.lowMidFreq === 320 && d.params.lowMidGain === -1.5,
    );
    expect(scoops.length).toBeGreaterThan(0);
    expect(scoops.map((d) => d.target).sort()).toEqual(["chords", "lead"]);
  });

  it("the scoop never touches bass (the kick/808 own the low end)", () => {
    const profile = planMixProfile(baseIntent({ artist: "axl-beats" }), {}, {});
    const bassScoop = profile.decisions.find(
      (d) => d.target === "bass" && d.effectType === "eq" && d.params.lowMidFreq === 320,
    );
    expect(bassScoop).toBeUndefined();
  });

  it("the scoop is surfaced in the human-readable summary", () => {
    const profile = planMixProfile(baseIntent({ artist: "axl-beats" }), {}, {});
    expect(profile.summary.some((line) => line.startsWith("scoop:"))).toBe(true);
  });

  it("an artist with no scoop emits no notch", () => {
    const profile = planMixProfile(baseIntent({ artist: "fred-again" }), {}, {});
    const scoops = profile.decisions.filter((d) => d.params.lowMidFreq === 320);
    expect(scoops.length).toBe(0);
  });
});

/* -------------------------------------------------------------------- */
/* signature.bpm / signature.keys planning hints (Phase 2 slice 5)        */
/* -------------------------------------------------------------------- */

describe("artistBpmHint", () => {
  it("returns the profile's tempo window", () => {
    expect(artistBpmHint(getArtistProfile("travis-scott"))).toEqual([140, 150]);
  });

  it("returns null for a missing profile", () => {
    expect(artistBpmHint(null)).toBeNull();
    expect(artistBpmHint(undefined)).toBeNull();
  });

  it("rejects a malformed range", () => {
    expect(artistBpmHint(profileFixtureWithBpm([150, 130]))).toBeNull();
    expect(artistBpmHint(profileFixtureWithBpm([0, 130]))).toBeNull();
  });
});

function profileFixtureWithBpm(typical: [number, number]): ArtistProfile {
  return profileFixture({ targetLufs: -7, tonalBalance: "x" }).signature.bpm.typical === typical
    ? { ...profileFixture({ targetLufs: -7, tonalBalance: "x" }) }
    : {
        ...profileFixture({ targetLufs: -7, tonalBalance: "x" }),
        signature: { sound: [], samples: [], bpm: { typical }, keys: [] },
      };
}

describe("artistHalfTimeHint", () => {
  it("returns the half-time window when declared", () => {
    expect(artistHalfTimeHint(getArtistProfile("travis-scott"))).toEqual([70, 75]);
  });

  it("returns null when the profile declares none", () => {
    expect(artistHalfTimeHint(getArtistProfile("burial"))).toBeNull();
  });
});

describe("artistKeyHint / artistKeyCandidates", () => {
  it("exposes the raw descriptor entries", () => {
    expect(artistKeyHint(getArtistProfile("travis-scott"))).toContain("F minor");
  });

  it("parses concrete roots into engine-shaped keys", () => {
    const candidates = artistKeyCandidates(getArtistProfile("travis-scott"));
    expect(candidates).toContain("F minor");
  });

  it("returns [] for a keyless / atonal entry (no concrete preference)", () => {
    // Aphex Twin's descriptor says "variable — often modal or atonal".
    expect(artistKeyCandidates(getArtistProfile("aphex-twin"))).toEqual([]);
  });

  it("returns [] for a missing profile", () => {
    expect(artistKeyCandidates(null)).toEqual([]);
  });
});

describe("planGeneration — artist tempo window constrains resolvedBpm", () => {
  it("with no artist, resolvedBpm is unchanged (no range means no resolution)", () => {
    const doc = createProjectFromTemplate("house");
    const plan = planGeneration(baseIntent(), doc);
    // The pre-slice behaviour: intent.bpmRange is null -> resolveBpm null.
    expect(plan.resolvedBpm).toBeNull();
    expect(plan.artistBpmRange).toBeUndefined();
  });

  it("an artist supplies the range when the intent has none", () => {
    const doc = createProjectFromTemplate("house");
    const plan = planGeneration(baseIntent({ artist: "travis-scott" }), doc);
    expect(plan.artistBpmRange).toEqual([140, 150]);
    // resolvedBpm must now land inside the artist window, not the groove's.
    if (plan.resolvedBpm !== null) {
      expect(plan.resolvedBpm).toBeGreaterThanOrEqual(140);
      expect(plan.resolvedBpm).toBeLessThanOrEqual(150);
    }
  });

  it("an explicit bpmRange still wins over the artist window", () => {
    const doc = createProjectFromTemplate("house");
    const plan = planGeneration(baseIntent({ artist: "travis-scott", bpmRange: [90, 100] }), doc);
    expect(plan.artistBpmRange).toBeUndefined();
    if (plan.resolvedBpm !== null) {
      expect(plan.resolvedBpm).toBeGreaterThanOrEqual(90);
      expect(plan.resolvedBpm).toBeLessThanOrEqual(100);
    }
  });

  it("an artist with no tempo window does not add a constraint", () => {
    const doc = createProjectFromTemplate("house");
    const plan = planGeneration(baseIntent({ artist: "not-a-real-artist" }), doc);
    expect(plan.artistBpmRange).toBeUndefined();
  });
});

describe("hasArtistSignature stays a pure guard", () => {
  it("is unaffected by the new plan hints", () => {
    expect(hasArtistSignature(getArtistProfile("travis-scott"))).toBe(true);
    expect(hasArtistSignature(null)).toBe(false);
  });
});
