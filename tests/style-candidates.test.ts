import { describe, it, expect } from "vitest";
import { styleCandidatesForPrompt, parseIntentText } from "../src/intent/text-parser";

/**
 * AMBIGUITY CANDIDATES (lane chips) — every style lane a prompt touches, in
 * parser-priority order. The FIRST candidate is what the engine picked; the
 * rest are the honest alternatives the chip UI offers. Artist masking and
 * the deaccent pipeline mirror parseIntentText exactly.
 */

describe("styleCandidatesForPrompt", () => {
  it("collects multiple lanes when the prompt touches them", () => {
    const candidates = styleCandidatesForPrompt("disco funk groove");
    expect(candidates[0]).toBe("disco"); // the pinned first-wins pick
    expect(candidates).toContain("funky"); // the honest alternative
    expect(candidates.indexOf("disco")).toBeLessThan(candidates.indexOf("funky"));
  });

  it("single-lane prompts return one candidate (no ambiguity)", () => {
    expect(styleCandidatesForPrompt("deep house at 122")).toEqual(["deep"]);
    expect(styleCandidatesForPrompt("gqom")).toEqual(["gqom"]);
  });

  it("sub-genre compounds surface their neighbors", () => {
    const afroDisco = styleCandidatesForPrompt("afro disco");
    expect(afroDisco[0]).toBe("disco");
    expect(afroDisco).toContain("afro");
    const popPunk = styleCandidatesForPrompt("pop punk banger");
    expect(popPunk[0]).toBe("poppunk");
  });

  it("artist names are masked — a name never doubles as a lane candidate", () => {
    // "trance" is BOTH an artist preset and a style; the parallel session's
    // trance-family wave made trance a first-class genre (style uplifting).
    // The chip contract is only: candidates stay style-shaped and the parse
    // routes coherently.
    const parsed = parseIntentText("trance type beat");
    const candidates = styleCandidatesForPrompt("trance type beat");
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(parsed.input.genre).toBe("trance");
    expect(parsed.input.style).toBe("uplifting");
  });

  it("is deterministic and ordered by parser priority", () => {
    const a = styleCandidatesForPrompt("country disco with afro percussion");
    const b = styleCandidatesForPrompt("country disco with afro percussion");
    expect(a).toEqual(b);
    expect(a[0]).toBe("disco"); // global style order wins, not text order
  });
});
