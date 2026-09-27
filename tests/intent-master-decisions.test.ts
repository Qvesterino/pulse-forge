import { describe, expect, it } from "vitest";
import { deepProfileToArtistMix } from "../src/intent/artist-profiles";
import { planMixProfile } from "../src/intent/mix";
import { SONG_LOUDNESS_TARGET_LUFS, SONG_LOUDNESS_TRIM_LIMIT_DB } from "../src/intent/genre-reference.generated";
import { INTENT_SCHEMA_VERSION, type IntentSpec } from "../src/intent/types";
import type { ArtistProfile } from "../src/intent/artist-profiles";

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

describe("deepProfileToArtistMix — master.targetLufs → lufs (Phase 2 slice 3)", () => {
  it("carries the artist's mastered LUFS as a signal", () => {
    expect(deepProfileToArtistMix(profileFixture({ targetLufs: -7, tonalBalance: "modern loud-master" })).lufs).toBe(
      -7,
    );
  });

  it("omits lufs when targetLufs is not finite", () => {
    expect(deepProfileToArtistMix(profileFixture({ targetLufs: Number.NaN, tonalBalance: "x" })).lufs).toBeUndefined();
  });
});

describe("deepProfileToArtistMix — master.dynamicRange → glue (Phase 2 slice 3)", () => {
  it('"low - ..." descriptor engages the glue', () => {
    expect(
      deepProfileToArtistMix(
        profileFixture({ targetLufs: -6, tonalBalance: "x", dynamicRange: "low - modern loud-master target" }),
      ).glue,
    ).toBe(true);
  });

  it('"limited - ..." descriptor engages the glue', () => {
    expect(
      deepProfileToArtistMix(
        profileFixture({
          targetLufs: -6,
          tonalBalance: "x",
          dynamicRange: "limited - club-system target, tight master",
        }),
      ).glue,
    ).toBe(true);
  });

  it('"wide - ..." descriptor bypasses the glue', () => {
    expect(
      deepProfileToArtistMix(
        profileFixture({
          targetLufs: -12,
          tonalBalance: "x",
          dynamicRange: "wide - NOT loud-mastered, character over loudness",
        }),
      ).glue,
    ).toBe(false);
  });

  it('"moderate - ..." descriptor leaves the glue alone (undefined)', () => {
    expect(
      deepProfileToArtistMix(
        profileFixture({
          targetLufs: -7,
          tonalBalance: "x",
          dynamicRange: "moderate - modern trap loud-master target",
        }),
      ).glue,
    ).toBeUndefined();
  });

  it("absent dynamicRange leaves the glue alone (undefined)", () => {
    expect(deepProfileToArtistMix(profileFixture({ targetLufs: -7, tonalBalance: "x" })).glue).toBeUndefined();
  });
});

describe("planMixProfile — master loudness bound (Phase 2 slice 3)", () => {
  it("a loud artist lifts the target but never past the trim limit", () => {
    // Travis Scott: targetLufs -7, so streaming -14 would need a 7 dB lift —
    // the cap trims it to the 6 dB the song builder already allows.
    const profile = planMixProfile(baseIntent("travis-scott"), {}, {});
    const expected = SONG_LOUDNESS_TARGET_LUFS + SONG_LOUDNESS_TRIM_LIMIT_DB;
    expect(profile.masterLufsTarget).toBe(expected);
    expect(profile.masterLufsTarget!).toBeGreaterThanOrEqual(SONG_LOUDNESS_TARGET_LUFS);
  });

  it("the loudest artist still respects the cap (Excision -6 would need 8 dB)", () => {
    // Excision's -6 is 8 dB above the streaming target; the 6 dB trim limit
    // holds it at -8 rather than letting a dubstep profile push the export
    // out of the streaming band the product guarantees.
    const profile = planMixProfile(baseIntent("excision"), {}, {});
    expect(profile.masterLufsTarget).toBe(SONG_LOUDNESS_TARGET_LUFS + SONG_LOUDNESS_TRIM_LIMIT_DB);
  });

  it("an artist just above the streaming target lifts by exactly the delta", () => {
    // J Dilla: targetLufs -13 is 1 dB louder than -14 -> a 1 dB lift, no cap hit.
    const profile = planMixProfile(baseIntent("j-dilla"), {}, {});
    expect(profile.masterLufsTarget).toBe(SONG_LOUDNESS_TARGET_LUFS + 1);
  });

  it("no artist signal leaves the master target untouched", () => {
    const profile = planMixProfile(baseIntent(undefined), {}, {});
    expect(profile.masterLufsTarget).toBeUndefined();
  });

  it("a mid artist lands between the streaming target and the cap", () => {
    // Anyma: targetLufs -9 -> a 5 dB lift, inside the 6 dB cap.
    const profile = planMixProfile(baseIntent("anyma"), {}, {});
    expect(profile.masterLufsTarget).toBe(SONG_LOUDNESS_TARGET_LUFS + 5);
  });
});

describe("planMixProfile — master glue (Phase 2 slice 3)", () => {
  it("a loud-master artist engages the glue", () => {
    // Excision: dynamicRange "low - ..." -> glue engaged.
    const profile = planMixProfile(baseIntent("excision"), {}, {});
    expect(profile.masterGlueEnabled).toBe(true);
  });

  it("a character-over-loudness artist bypasses the glue", () => {
    // J Dilla: dynamicRange "wide - ..." -> glue bypassed.
    const profile = planMixProfile(baseIntent("j-dilla"), {}, {});
    expect(profile.masterGlueEnabled).toBe(false);
  });

  it("a moderate artist leaves the glue alone", () => {
    // Travis Scott: dynamicRange "moderate - ..." -> no opinion.
    const profile = planMixProfile(baseIntent("travis-scott"), {}, {});
    expect(profile.masterGlueEnabled).toBeUndefined();
  });

  it("no artist signal leaves the glue alone", () => {
    const profile = planMixProfile(baseIntent(undefined), {}, {});
    expect(profile.masterGlueEnabled).toBeUndefined();
  });
});

describe("planMixProfile — master decisions are deterministic + reported", () => {
  it("repeated calls produce identical master signals", () => {
    const a = planMixProfile(baseIntent("travis-scott"), {}, {});
    const b = planMixProfile(baseIntent("travis-scott"), {}, {});
    expect(a.masterLufsTarget).toBe(b.masterLufsTarget);
    expect(a.masterGlueEnabled).toBe(b.masterGlueEnabled);
  });

  it("the loudness decision is surfaced in the human-readable summary", () => {
    const profile = planMixProfile(baseIntent("travis-scott"), {}, {});
    expect(profile.summary.some((line) => line.includes("LUFS"))).toBe(true);
  });

  it("the glue decision is surfaced in the human-readable summary", () => {
    const profile = planMixProfile(baseIntent("excision"), {}, {});
    expect(profile.summary.some((line) => line.startsWith("master glue"))).toBe(true);
  });
});
