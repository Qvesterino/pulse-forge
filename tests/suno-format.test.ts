import { describe, expect, it } from "vitest";
import { parseSunoFormat } from "../src/intent/suno-format";
import { buildSong } from "../src/intent/song";
import { testDoc } from "./fixtures/doc";

/**
 * SUNO-FORMAT COMPATIBILITY (W4 of the vocal campaign, 2026-10-12) — the
 * bracketed prompt format ([Verse] / [Chorus] + lyric lines) defines the
 * song: the bracket sequence IS the arrangement (roles in order, bar counts
 * scaling with lyric length, chorus fill / bridge break baked by the
 * transitions), and the parsed structure feeds the hum→voice wave. A SUNO
 * prompt pasted into KYX becomes an EDITABLE project.
 */

const PROMPT = [
  "[Intro]",
  "[Verse 1]",
  "City lights are calling out my name",
  "Walking through the neon rain",
  "[Chorus]",
  "We are the ones who light the flame",
  "[Bridge]",
  "Slow down now",
  "[Chorus]",
  "We are the ones who light the flame",
].join("\n");

describe("parseSunoFormat", () => {
  it("reads the bracket sequence as roles in order with lyrics per section", () => {
    const parsed = parseSunoFormat(PROMPT);
    expect(parsed).not.toBeNull();
    expect(parsed!.sections.map((s) => s.role)).toEqual(["intro", "verse", "chorus", "bridge", "chorus"]);
    expect(parsed!.sections[1].lyrics).toEqual([
      "City lights are calling out my name",
      "Walking through the neon rain",
    ]);
    expect(parsed!.sections[2].lyrics).toEqual(["We are the ones who light the flame"]);
  });

  it("unknown bracket tags become boundaries without a role", () => {
    const parsed = parseSunoFormat("[Verse]\nla la\n[Instrumental]\n[Chorus]\noh oh");
    expect(parsed!.sections.map((s) => s.role)).toEqual(["verse", "verse", "chorus"]);
  });

  it("non-bracketed text is honest-null (not this format)", () => {
    expect(parseSunoFormat("dark techno 140")).toBeNull();
    expect(parseSunoFormat("")).toBeNull();
  });
});

describe("buildSong with a SUNO prompt", () => {
  it("the bracketed prompt defines the arrangement end-to-end", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, { genre: "rock", seed: "suno-e2e", length: 64 }, { lyrics: PROMPT });
    // The bracket sequence IS the form: 5 sections in the prompt's order.
    expect(build.sections.map((s) => s.role)).toEqual(["intro", "verse", "chorus", "bridge", "chorus"]);
    // Bar counts scale with lyric length (2 bars per lyric line, min 4).
    expect(build.sections[1].bars).toBe(4); // 2 lyric lines → 4 bars
    expect(build.sections[2].bars).toBe(4); // 1 lyric line → floor 4
    // The chorus boundary carries the fill (the form's own transition rule).
    expect(build.sections[2].transitionIn).toBe("fill");
    // Deterministic rebuild.
    const again = await buildSong(doc, { genre: "rock", seed: "suno-e2e", length: 64 }, { lyrics: PROMPT });
    expect(again.sections.map((s) => s.label)).toEqual(build.sections.map((s) => s.label));
  });
});
