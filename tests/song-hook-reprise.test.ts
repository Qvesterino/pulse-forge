import { describe, it, expect } from "vitest";
import { applyLeadHook, buildSong, type SongBuildSection } from "../src/intent/song";
import { testDoc } from "./fixtures/doc";
import { instrumentTrackForRole } from "../src/ai/role-targets";
import type { NoteEvent, Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * LEAD MOTIF REPRISE (2026-10-10) — the chorus hook: before this wave every
 * section's lead was an independent dice roll, so a song had no signature
 * you could hum. Now the FIRST hook section (chorus/drop) that carries a
 * lead is the donor, and every later hook section replays THAT motif
 * (repeated to its own length) — verses and the bridge keep their generated
 * contrast, and a hook section whose instrumentation said "no lead" stays
 * honest-empty. The hook is whatever the donor generated, just arranged.
 */

/** Note times are TICKS (a 16th = 120 ticks); this helper takes 16th STEPS. */
const STEP_TICKS = 120;
let noteSeq = 0;
function note(startStep: number, pitch: number, durationSteps = 1, velocity = 0.8): NoteEvent {
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

const lead = (doc: ProjectDocument) => instrumentTrackForRole(doc, "lead")!;

/**
 * The house fixture ships only two instrument tracks, so the role resolver's
 * index fallback maps bass AND lead onto the same 808 — the hook would then
 * read a bass/lead mix. A dedicated "Lead Guitar" track gives the lead its
 * own voice (the resolver matches by name).
 */
function songDoc(): ProjectDocument {
  const doc = testDoc();
  return {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.kind === "instrument" && t.instrument === "analog" ? { ...t, name: "Lead Guitar" } : t,
    ),
  };
}

/** Lead content of one section with the random ids stripped. */
function leadContent(section: SongBuildSection, leadTrackId: string): string {
  const notes = section.pattern.notes[leadTrackId] ?? [];
  return JSON.stringify(notes.map((n) => [n.pitch, n.start, n.duration, n.velocity]));
}

describe("applyLeadHook (pure)", () => {
  it("later hook sections replay the donor motif; verses and the bridge keep their contrast", () => {
    const doc = testDoc();
    const track = lead(doc);
    const trackId = track.id;
    const motif = [note(0, 76), note(4, 79), note(8, 74), note(12, 71)];
    const verseLead = [note(0, 60), note(8, 62)];
    const bridgeLead = [note(0, 65)];
    const sections = [
      section("intro", "Intro", 16, [], trackId),
      section("verse", "Verse 1", 16, verseLead, trackId),
      section("chorus", "Chorus 1", 16, motif, trackId), // donor
      section("verse", "Verse 2", 16, verseLead, trackId),
      section("bridge", "Bridge", 16, bridgeLead, trackId),
      section("chorus", "Chorus 2", 16, [note(0, 55), note(6, 57)], trackId), // replaced
      section("chorus", "Chorus 3", 16, [note(2, 50)], trackId), // replaced
      section("outro", "Outro", 16, [], trackId),
    ];
    const hooked = applyLeadHook(doc, sections);
    expect(leadContent(hooked[2], track.id)).toBe(leadContent(sections[2], track.id)); // donor untouched
    expect(leadContent(hooked[5], track.id)).toBe(leadContent(sections[2], track.id)); // chorus 2 = the hook
    expect(leadContent(hooked[6], track.id)).toBe(leadContent(sections[2], track.id)); // chorus 3 = the hook
    expect(leadContent(hooked[1], track.id)).toBe(leadContent(sections[1], track.id)); // verse contrast kept
    expect(leadContent(hooked[4], track.id)).toBe(leadContent(sections[4], track.id)); // bridge turn kept
    // Structural: the donor motif returns note-for-note (order + pitches).
    const hookNotes = hooked[5].pattern.notes[track.id]!;
    expect(hookNotes.map((n) => n.pitch)).toEqual(motif.map((n) => n.pitch));
  });

  it("a longer hook section repeats the motif to fill; a shorter one trims", () => {
    const doc = testDoc();
    const track = lead(doc);
    const motif = [note(0, 76, 2), note(8, 74, 8)];
    const trackId = track.id;
    const sections = [
      section("chorus", "Chorus 1", 16, motif, trackId),
      section("chorus", "Chorus 2 (double)", 32, [note(0, 50)], trackId),
      section("chorus", "Chorus 3 (short)", 8, [note(0, 50)], trackId),
    ];
    const hooked = applyLeadHook(doc, sections);
    const doubled = hooked[1].pattern.notes[track.id]!;
    expect(doubled).toHaveLength(4); // motif × 2
    expect(doubled.filter((n) => n.pitch === 76).map((n) => n.start)).toEqual([0, 16 * STEP_TICKS]);
    // The 8-step tail of the second cycle is trimmed to the section end.
    expect(doubled.find((n) => n.pitch === 74 && n.start === 24 * STEP_TICKS)?.duration).toBe(8 * STEP_TICKS);
    const short = hooked[2].pattern.notes[track.id]!;
    expect(short.map((n) => n.start)).toEqual([0]); // second cycle would start at 16 ≥ 8 — dropped
  });

  it("honest-empty stays empty and a song without a donor lead is returned unchanged", () => {
    const doc = testDoc();
    const track = lead(doc);
    // Instrumentation said no lead in chorus 2 — it must stay empty, not inherit.
    const trackId = track.id;
    const sections = [
      section("chorus", "Chorus 1", 16, [note(0, 76)], trackId),
      section("chorus", "Break (no lead)", 16, [], trackId),
    ];
    const hooked = applyLeadHook(doc, sections);
    expect(hooked[1].pattern.notes[trackId] ?? []).toEqual([]);
    // No hook section carries a lead anywhere → same sections back.
    const leadless = [section("verse", "V", 16, [note(0, 60)], trackId), section("chorus", "C", 16, [], trackId)];
    expect(applyLeadHook(doc, leadless)).toEqual(leadless);
  });
});

describe("buildSong hook reprise (end-to-end)", () => {
  it("every chorus of a generated song plays the SAME hook", async () => {
    const doc = songDoc();
    const build = await buildSong(doc, { genre: "rock", seed: "hook-e2e", length: 64 }, {});
    const track = lead(doc);
    const choruses = build.sections.filter((s) => s.role === "chorus" || s.role === "drop");
    const withLead = choruses.filter((s) => (s.pattern.notes[track.id] ?? []).length > 0);
    expect(withLead.length, "the fixture produces at least two lead-carrying hooks").toBeGreaterThanOrEqual(2);
    // The implanted copies match EACH OTHER exactly, and they extend the
    // donor (the donor keeps its original tail; copies may be trimmed to
    // their own section end).
    const donorContent = leadContent(withLead[0], track.id);
    const implanted = withLead.slice(1).map((s) => leadContent(s, track.id));
    expect(new Set(implanted).size, "all implanted copies identical").toBe(1);
    const donorHead = JSON.parse(donorContent).slice(0, 2);
    const implantedHead = JSON.parse(implanted[0]).slice(0, 2);
    expect(implantedHead, "copies start with the donor's motif").toEqual(donorHead);
  });

  it("hookReprise: false restores the legacy independent leads (A/B escape hatch)", async () => {
    const doc = songDoc();
    const build = await buildSong(doc, { genre: "rock", seed: "hook-e2e", length: 64 }, { hookReprise: false });
    const track = lead(doc);
    const choruses = build.sections.filter((s) => s.role === "chorus" || s.role === "drop");
    const withLead = choruses.filter((s) => (s.pattern.notes[track.id] ?? []).length > 0);
    const contents = new Set(withLead.map((s) => leadContent(s, track.id)));
    expect(contents.size, "independent leads stay independent").toBe(withLead.length);
  });
});
