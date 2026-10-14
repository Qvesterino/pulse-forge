import { describe, expect, it } from "vitest";
import { parseSunoFormat } from "../src/intent/suno-format";
import { parseSectionRequests } from "../src/intent/sections";
import { applySongCommand, buildSong } from "../src/intent/song";
import { composeFullTrack } from "../src/intent/compose";
import { instrumentTrackForRole } from "../src/ai/role-targets";
import { BAR_TICKS } from "../src/project-model/types";
import { buildProsodyGrid, buildSyllableTimeline } from "../src/vocal/prosody";
import { testDoc } from "./fixtures/doc";

/**
 * SUNO-FORMAT COMPATIBILITY (W4 of the vocal campaign, 2026-10-12) — the
 * bracketed prompt format ([Verse] / [Chorus] + lyric lines) defines the
 * song: the bracket sequence IS the arrangement (roles in order, bar counts
 * scaling with lyric phrasing, the generated lead follows syllabic rhythm,
 * and chorus/bridge transitions are baked into the arrangement. A bracketed
 * prompt pasted into KYX becomes an EDITABLE project without storing lyrics.
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

  it("unknown bracket tags become boundaries — instrumental reads as break", () => {
    const parsed = parseSunoFormat("[Verse]\nla la\n[Instrumental]\n[Chorus]\noh oh");
    // [Instrumental] maps to the break role (an instrumental passage IS a
    // break-shaped section in the form vocabulary).
    expect(parsed!.sections.map((s) => s.role)).toEqual(["verse", "break", "chorus"]);
  });

  it("non-bracketed text is honest-null (not this format)", () => {
    expect(parseSunoFormat("dark techno 140")).toBeNull();
    expect(parseSunoFormat("")).toBeNull();
  });

  it("keeps lyric words out of section-request parsing", () => {
    const parsed = parseSectionRequests("house at 122\n[Verse]\nno break\nvinyl break")!;
    expect(parsed.requests).toEqual([]);
    expect(parsed.scopedFx).toEqual([]);
    expect(parsed.remainingText).toBe("house at 122");
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
    const verse = build.sections[1];
    const leadTrack = instrumentTrackForRole(doc, "lead");
    expect(verse?.lyrics).toEqual(["City lights are calling out my name", "Walking through the neon rain"]);
    expect(leadTrack).not.toBeNull();
    const leadNotes = verse?.pattern.notes[leadTrack!.id] ?? [];
    const prosody = buildProsodyGrid(buildSyllableTimeline(verse!.lyrics!.join("\n")));
    expect(leadNotes).toHaveLength(prosody.notes.length);
    expect(leadNotes.map((note) => note.start)).toEqual(prosody.notes.map((note) => note.startStep * (BAR_TICKS / 16)));
    // Deterministic rebuild.
    const again = await buildSong(doc, { genre: "rock", seed: "suno-e2e", length: 64 }, { lyrics: PROMPT });
    expect(again.sections.map((s) => s.label)).toEqual(build.sections.map((s) => s.label));
    const installed = applySongCommand(doc, build).execute(doc);
    expect(JSON.stringify(installed)).not.toContain("City lights are calling out my name");
  });

  it("splits long lyric sections into pattern-sized parts without dropping lines", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1} has a small phrase`);
    const prompt = `[Verse]\n${lines.join("\n")}\n[Outro]`;
    const build = await buildSong(testDoc(), { genre: "rock", seed: "suno-long-verse" }, { lyrics: prompt });
    const verseParts = build.sections.filter((section) => section.role === "verse");
    expect(verseParts).toHaveLength(2);
    expect(verseParts.flatMap((section) => section.lyrics ?? [])).toEqual(lines);
    expect(verseParts.every((section) => section.pattern.stepCount <= 256)).toBe(true);
  });
});

describe("composeFullTrack with a bracketed prompt", () => {
  it("parses only the preamble as musical intent and keeps lyric text transient", async () => {
    const doc = testDoc();
    const lyric = "A private line about the moonlight";
    const result = await composeFullTrack(doc, `house at 122\n[Verse]\n${lyric}\n[Chorus]\nwe rise`, {
      seed: "suno-compose",
      loudness: false,
    });

    expect(result.build.baseIntent.genre).toBe("house");
    expect(result.build.baseIntent.text).toBe("house at 122");
    expect(result.build.sections.map((section) => section.role)).toEqual(["verse", "chorus"]);
    const installed = result.commands.song.execute(doc);
    expect(JSON.stringify(installed)).not.toContain(lyric);
  });
});

describe("vocabulary expansion (2026-10-12)", () => {
  it("reads the extended tag set — pre/post-chorus, interlude, instrumental, solo, spoken, fade", () => {
    const parsed = parseSunoFormat(
      [
        "[Intro]",
        "[Pre-Chorus]",
        "building up",
        "[Chorus]",
        "we fly",
        "[Post-Chorus]",
        "[Interlude]",
        "[Instrumental]",
        "[Solo]",
        "[Spoken Word]",
        "and then he said",
        "[Fade Out]",
      ].join("\n"),
    )!;
    expect(parsed.sections.map((s) => s.role)).toEqual([
      "intro",
      "build",
      "chorus",
      "chorus",
      "bridge",
      "break",
      "bridge",
      "verse",
      "outro",
    ]);
    expect(parsed.sections[7].lyrics).toEqual(["and then he said"]);
  });

  it("reads SK tags — sloha, refren, mostik, záver", () => {
    const parsed = parseSunoFormat("[Intro]\n[Sloha 1]\nnejaky text\n[Refrén]\njo jo\n[Záver]");
    expect(parsed!.sections.map((s) => s.role)).toEqual(["intro", "verse", "chorus", "outro"]);
  });

  it("the tag repeat suffix — [Chorus x2] — rides into the section", () => {
    const parsed = parseSunoFormat("[Chorus x2]\nwe fly\n[Verse 2x]\ntalk");
    expect(parsed!.sections.map((s) => s.repeats)).toEqual([2, 2]);
  });
});

describe("repeats expansion (2026-10-12 strengthening)", () => {
  it("[Chorus x2] expands into TWO chorus sections with numbered relabels", async () => {
    const { buildSong } = await import("../src/intent/song");
    const doc = (await import("./fixtures/doc")).testDoc();
    const build = await buildSong(
      doc,
      { genre: "rock", seed: "repeats-e2e", length: 64 },
      { lyrics: "[Intro]\n[Verse]\nla la la\n[Chorus x2]\nwe fly\n[Outro]" },
    );
    const roles = build.sections.map((s) => s.role);
    expect(roles).toEqual(["intro", "verse", "chorus", "chorus", "outro"]);
    const chorusLabels = build.sections.filter((s) => s.role === "chorus").map((s) => s.label);
    expect(chorusLabels[0]).toMatch(/1\/2/);
    expect(chorusLabels[1]).toMatch(/2\/2/);
  });
});
