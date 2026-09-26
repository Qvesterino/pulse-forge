import { describe, expect, it } from "vitest";
import {
  ARTIST_PROFILES,
  countByVerificationStatus,
  findProfilesByVibe,
  getArtistProfile,
  type ArtistProfile,
} from "../src/intent/artist-profiles";

describe("artist-profiles registry", () => {
  it("ships the seven profiles (drill / phonk / jersey / trap / trap / lofi / house)", () => {
    expect(Object.keys(ARTIST_PROFILES).sort()).toEqual([
      "axl-beats",
      "dj-tameil",
      "dvrst",
      "fred-again",
      "j-dilla",
      "metro-boomin",
      "travis-scott",
    ]);
  });

  it("every profile carries the required shape fields", () => {
    for (const profile of Object.values(ARTIST_PROFILES)) {
      expect(profile.slug).toBeTruthy();
      expect(profile.name).toBeTruthy();
      expect(profile.genres.length).toBeGreaterThan(0);
      expect(profile.signature.sound.length).toBeGreaterThan(0);
      expect(profile.signature.bpm.typical).toHaveLength(2);
      // BPM range sanity
      const [bpmMin, bpmMax] = profile.signature.bpm.typical;
      expect(bpmMin).toBeLessThan(bpmMax);
      expect(bpmMin).toBeGreaterThanOrEqual(40);
      expect(bpmMax).toBeLessThanOrEqual(220);
      expect(profile.mix).toBeTruthy();
      expect(profile.master.targetLufs).toBeLessThan(0); // LUFS negative by convention
      expect(profile.master.tonalBalance).toBeTruthy();
      expect(profile.gear.length).toBeGreaterThan(0);
      expect(profile.vibe.length).toBeGreaterThan(0);
      expect(profile.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("getArtistProfile", () => {
  it("returns the profile when the slug exists", () => {
    const profile = getArtistProfile("dvrst");
    expect(profile?.name).toBe("DVRST");
    expect(profile?.genres).toContain("drill");
  });

  it("returns undefined for an unknown slug (no throw)", () => {
    expect(getArtistProfile("not-a-real-slug")).toBeUndefined();
    expect(getArtistProfile("")).toBeUndefined();
  });
});

describe("findProfilesByVibe", () => {
  it("matches by vibe descriptor (case-insensitive)", () => {
    const matches = findProfilesByVibe("dark");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((p) => p.vibe.some((word) => word.toLowerCase().includes("dark")))).toBe(
      true,
    );
  });

  it("matches by signature sound descriptor", () => {
    const matches = findProfilesByVibe("cowbell");
    expect(matches.map((p: ArtistProfile) => p.slug)).toContain("dvrst");
  });

  it("matches by artist name", () => {
    const matches = findProfilesByVibe("tameil");
    expect(matches.map((p) => p.slug)).toContain("dj-tameil");
  });

  it("returns an empty array for unknown vibe / empty needle", () => {
    expect(findProfilesByVibe("nonexistent-vibe-word-xyz")).toEqual([]);
    expect(findProfilesByVibe("")).toEqual([]);
    expect(findProfilesByVibe("   ")).toEqual([]);
  });
});

describe("verification-status discipline", () => {
  it("every pilot profile carries an explicit status (not defaulted)", () => {
    for (const profile of Object.values(ARTIST_PROFILES)) {
      expect(["ai-inferred", "mixed", "verified"]).toContain(profile.verificationStatus);
    }
  });

  it("the registry currently reports all profiles as ai-inferred (plan balance exhausted)", () => {
    const counts = countByVerificationStatus();
    expect(counts["ai-inferred"]).toBe(Object.keys(ARTIST_PROFILES).length);
    expect(counts.verified).toBe(0);
  });

  it("every profile has at least one source URL backing the claims", () => {
    // Even AI-inferred profiles carry real URLs that need to be re-checked
    // when the plan balance is recharged — discipline for the future
    // verification pass.
    for (const profile of Object.values(ARTIST_PROFILES)) {
      expect(profile.sources.length).toBeGreaterThan(0);
      for (const url of profile.sources) {
        expect(url).toMatch(/^https?:\/\//);
      }
    }
  });
});
