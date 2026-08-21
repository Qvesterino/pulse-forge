import { describe, expect, it } from "vitest";
import {
  getScalePitchesInRange,
  isInScale,
  snapToScale,
  scaleDegreeLabel,
  parseKey,
  formatKey,
} from "../src/project-model/scales";
import { MUSICAL_KEYS } from "../src/project-model/types";

describe("scales", () => {
  describe("parseKey / formatKey", () => {
    it("parses 'C Major' into root=0, scaleType=major", () => {
      const parsed = parseKey("C Major" as any);
      expect(parsed).toEqual({ root: 0, scaleType: "major" });
    });
    it("parses 'A# Natural Minor' into root=10, scaleType=natural_minor", () => {
      const parsed = parseKey("A# Natural Minor" as any);
      expect(parsed).toEqual({ root: 10, scaleType: "natural_minor" });
    });
    it("returns null for invalid keys", () => {
      expect(parseKey("C Foobar" as any)).toBeNull();
      expect(parseKey("" as any)).toBeNull();
    });
    it("formatKey round-trips with parseKey", () => {
      for (const key of MUSICAL_KEYS.slice(0, 12)) {
        const parsed = parseKey(key)!;
        const formatted = formatKey(parsed.root, parsed.scaleType);
        expect(formatted).toBe(key);
      }
    });
  });

  describe("getScalePitchesInRange", () => {
    it("C Major contains C4 (60), E4 (64), G4 (67) but not F#4 (66)", () => {
      const pitches = getScalePitchesInRange("C Major" as any, 60, 67);
      expect(pitches.has(60)).toBe(true);
      expect(pitches.has(64)).toBe(true);
      expect(pitches.has(67)).toBe(true);
      expect(pitches.has(66)).toBe(false);
    });
    it("pentatonic has 5 notes per octave", () => {
      const pitches = getScalePitchesInRange("C Pentatonic Major" as any, 60, 71);
      expect(pitches.size).toBe(5);
    });
    it("handles out-of-range by returning empty set for invalid keys", () => {
      const pitches = getScalePitchesInRange("" as any, 60, 80);
      expect(pitches.size).toBe(0);
    });
  });

  describe("isInScale", () => {
    it("C4 (60) is in C Major", () => {
      expect(isInScale(60, "C Major" as any)).toBe(true);
    });
    it("F#4 (66) is NOT in C Major", () => {
      expect(isInScale(66, "C Major" as any)).toBe(false);
    });
    it("returns true for empty/invalid key", () => {
      expect(isInScale(60, "" as any)).toBe(true);
    });
  });

  describe("snapToScale", () => {
    it("returns pitch unchanged if already in scale", () => {
      expect(snapToScale(60, "C Major" as any)).toBe(60);
      expect(snapToScale(64, "C Major" as any)).toBe(64);
    });
    it("snaps F#4 (66) to nearest: F4 (65) or G4 (67)", () => {
      const result = snapToScale(66, "C Major" as any);
      expect([65, 67]).toContain(result);
    });
    it("snaps within octaves correctly", () => {
      // F#3 (54, semitone 6) is NOT in C Major; should snap to E3 (52) or F3 (53)
      const result = snapToScale(54, "C Major" as any);
      expect([52, 53]).toContain(result);
    });
    it("returns pitch unchanged if key is invalid", () => {
      expect(snapToScale(60, "" as any)).toBe(60);
    });
  });

  describe("scaleDegreeLabel", () => {
    it("returns '1' for root of C Major (C4 = 60)", () => {
      expect(scaleDegreeLabel(60, "C Major" as any)).toBe("1");
    });
    it("returns '3' for E4 (64) in C Major", () => {
      expect(scaleDegreeLabel(64, "C Major" as any)).toBe("3");
    });
    it("returns null for out-of-scale pitch", () => {
      expect(scaleDegreeLabel(66, "C Major" as any)).toBeNull();
    });
    it("returns null for empty key", () => {
      expect(scaleDegreeLabel(60, "" as any)).toBeNull();
    });
  });

  describe("MUSICAL_KEYS", () => {
    it("has exactly 108 entries (12 roots × 9 scales)", () => {
      expect(MUSICAL_KEYS.length).toBe(108);
    });
    it("covers all scale types for C root", () => {
      const cKeys = MUSICAL_KEYS.filter((k) => k.startsWith("C "));
      expect(cKeys.length).toBe(9);
      expect(cKeys).toContain("C Major");
      expect(cKeys).toContain("C Natural Minor");
      expect(cKeys).toContain("C Harmonic Minor");
      expect(cKeys).toContain("C Dorian");
      expect(cKeys).toContain("C Pentatonic Major");
    });
  });

  describe("integration: scale snapping end-to-end", () => {
    it("snap a chromatic sequence to C Major", () => {
      // C, C#, D, D#, E, F, F# → C, D, D, E, E, F, G (approximate)
      const input = [60, 61, 62, 63, 64, 65, 66];
      const output = input.map((p) => snapToScale(p, "C Major" as any));
      // All results should be in C Major
      for (const p of output) {
        expect(isInScale(p, "C Major" as any)).toBe(true);
      }
      // C (60) and E (64) should stay unchanged
      expect(output[0]).toBe(60);
      expect(output[4]).toBe(64);
    });
  });
});
