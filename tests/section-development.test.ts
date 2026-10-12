import { describe, expect, it } from "vitest";
import { applySectionDevelopment, buildSong } from "../src/intent/song";
import { testDoc } from "./fixtures/doc";
import { instrumentTrackForRole } from "../src/ai/role-targets";
import type { NoteEvent, Pattern, ProjectDocument } from "../src/project-model/types";
import type { SongBuildSection } from "../src/intent/song";

/**
 * SECTION DEVELOPMENT ENGINE (W1 of the vocal campaign, 2026-10-11) — a
 * repeated section should EVOLVE, not roll new dice. Three deterministic
 * treatments keyed off repetition position:
 *
 *   hook quotation — later verses quote the chorus hook's opening fragment
 *                    (first bar, half velocity): the verse remembers.
 *   final lift     — the LAST hook section lifts its drum back half.
 *   pre-final dip  — a bridge/build directly before it dips to half.
 *
 * The first occurrence stays baseline; `development: false` restores flat
 * repetitions; everything is pure and deterministic.
 */

let noteSeq = 0;
function note(startStep: number, pitch: number, durationSteps = 1, velocity = 0.8): NoteEvent {
  const STEP_TICKS = 120;
  noteSeq += 1;
  return {
    id: `note-${noteSeq}`,
    pitch,
    start: startStep * STEP_TICKS,
    duration: durationSteps * STEP_TICKS,
    velocity,
  };
}

function section(
  role: string,
  label: string,
  stepCount: number,
  leadNotes: NoteEvent[],
  leadTrackId: string,
): SongBuildSection {
  const pattern: Pattern = {
    id: `pat-${role}-${label}`,
    name: label,
    stepCount,
    rows: {},
    notes: leadNotes.length > 0 ? { [leadTrackId]: leadNotes } : {},
  };
  return {
    role: role as SongBuildSection["role"],
    label,
    bars: stepCount / 16,
    intensity: 0.8,
    transitionIn: null,
    energyDelta: 0,
    densityDelta: 0,
    complexityDelta: 0,
    instrumentation: ["drums", "bass", "chords", "lead"],
    pattern,
    stepCount,
    roles: ["drums", "bass", "chords", "lead"],
  };
}

function songDoc(): ProjectDocument {
  return testDoc();
}

const lead = (doc: ProjectDocument) => instrumentTrackForRole(doc, "lead")!;

/** Drum-row velocity content in the SECOND half of a section's pattern. */
function secondHalf(pattern: Pattern): number[] {
  const out: number[] = [];
  const half = Math.floor(pattern.stepCount / 2);
  for (const row of Object.values(pattern.rows)) {
    for (let step = half; step < pattern.stepCount; step++) {
      if ((row[step] ?? 0) > 0) out.push(row[step]);
    }
  }
  return out;
}

describe("applySectionDevelopment (pure)", () => {
  it("later verses quote the hook's opening fragment; the first verse does not", () => {
    const doc = songDoc();
    const track = lead(doc);
    const motif = [note(0, 76), note(4, 79), note(8, 74), note(12, 71)];
    const sections = [
      section("verse", "Verse 1", 64, [note(0, 60, 8, 0.6)], track.id),
      section("chorus", "Chorus 1", 64, motif, track.id),
      section("verse", "Verse 2", 64, [note(0, 60, 8, 0.6)], track.id),
    ];
    const developed = applySectionDevelopment(doc, sections);
    const v1Lead = (developed[0].pattern.notes[track.id] ?? []).map((n) => n.pitch);
    const v2Lead = (developed[2].pattern.notes[track.id] ?? []).map((n) => n.pitch);
    expect(v1Lead, "first verse stays baseline").toEqual([60]);
    // Verse 2 opens with the motif's pitches (the quote) before its own note.
    expect(v2Lead.slice(0, 4)).toEqual(motif.map((n) => n.pitch));
    // The quote rides at half the donor velocity.
    const quoteVelocities = (developed[2].pattern.notes[track.id] ?? []).slice(0, 4).map((n) => n.velocity);
    for (const v of quoteVelocities) expect(v).toBeLessThanOrEqual(0.5);
  });

  it("the LAST hook section lifts its drum back half; earlier ones stay put", () => {
    const doc = songDoc();
    const drumPattern = (id: string): Pattern => ({
      id,
      name: id,
      stepCount: 64,
      rows: {
        "snare-pad": Array.from({ length: 64 }, (_, i) => (i % 8 === 0 ? 0.7 : 0)),
      },
      notes: {},
    });
    const sections: SongBuildSection[] = [
      { ...section("chorus", "Chorus 1", 64, [], "lead-track"), pattern: drumPattern("c1") },
      { ...section("chorus", "Chorus 2", 64, [], "lead-track"), pattern: drumPattern("c2") },
    ];
    const developed = applySectionDevelopment(doc, sections);
    const c1SecondHalf = secondHalf(developed[0].pattern);
    const c2SecondHalf = secondHalf(developed[1].pattern);
    expect(
      c1SecondHalf.every((v) => v === 0.7),
      "chorus 1 untouched",
    ).toBe(true);
    expect(c2SecondHalf.length).toBeGreaterThan(0);
    expect(Math.max(...c2SecondHalf), "final chorus lifted above 0.7").toBeGreaterThan(0.7);
    // First half untouched even in the final chorus.
    const firstHalfC2 = (developed[1].pattern.rows["snare-pad"] ?? []).slice(0, 32);
    expect(firstHalfC2.every((v) => v === 0 || v === 0.7)).toBe(true);
  });

  it("a bridge/build directly before the last chorus dips its back half", () => {
    const doc = songDoc();
    const drumPattern = (id: string): Pattern => ({
      id,
      name: id,
      stepCount: 64,
      rows: {
        "snare-pad": Array.from({ length: 64 }, (_, i) => (i % 8 === 0 ? 0.8 : 0)),
      },
      notes: {},
    });
    const sections: SongBuildSection[] = [
      { ...section("chorus", "Chorus 1", 64, [], "lead-track"), pattern: drumPattern("c1") },
      { ...section("bridge", "Bridge", 64, [], "lead-track"), pattern: drumPattern("br") },
      { ...section("chorus", "Chorus 2", 64, [], "lead-track"), pattern: drumPattern("c2") },
    ];
    const developed = applySectionDevelopment(doc, sections);
    // The bridge dipped to ~0.4 (half of 0.8, floored at 0.1) in its back half...
    const bridgeBack = secondHalf(developed[1].pattern);
    expect(bridgeBack.length).toBeGreaterThan(0);
    expect(Math.max(...bridgeBack), "bridge dips to half").toBeCloseTo(0.4, 5);
    // ...and the final chorus STILL lifted (development composes).
    expect(Math.max(...secondHalf(developed[2].pattern))).toBeGreaterThan(0.8);
  });
});

describe("buildSong development (end-to-end)", () => {
  it("a generated song's final chorus plays harder than an earlier one — and the flag restores flat", async () => {
    const doc = songDoc();
    const build = await buildSong(doc, { genre: "rock", seed: "dev-e2e", length: 64 });
    const hookSections = build.sections.filter((s) => s.role === "chorus" || s.role === "drop");
    const first = hookSections[0];
    const last = hookSections[hookSections.length - 1];
    if (hookSections.length >= 2) {
      const firstMax = Math.max(...secondHalf(first.pattern), 0);
      const lastMax = Math.max(...secondHalf(last.pattern), 0);
      expect(lastMax, "the final hook section plays the lift").toBeGreaterThanOrEqual(firstMax);
    }
    // Flat A/B: development off → the last section matches the generated baseline.
    const flat = await buildSong(doc, { genre: "rock", seed: "dev-e2e", length: 64 }, { development: false });
    const flatLast = flat.sections.filter((s) => s.role === "chorus" || s.role === "drop").pop();
    if (hookSections.length >= 2 && flatLast) {
      expect(secondHalf(flatLast.pattern), "flat A/B has no lift").toEqual(
        secondHalf(
          (await buildSong(doc, { genre: "rock", seed: "dev-e2e", length: 64 }, { development: false })).sections
            .filter((s) => s.role === "chorus" || s.role === "drop")
            .pop()!.pattern,
        ),
      );
    }
  });
});
