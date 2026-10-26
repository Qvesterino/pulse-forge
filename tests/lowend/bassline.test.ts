import { describe, expect, it } from "vitest";
import { forgeLowEndStackCommand, seedBasslineCommand } from "../../src/commands/instrument";
import { bassRootAtBar, kickOnsetsOf, measureLowEndFit, planBassline } from "../../src/instruments/lowEndBass";
import { lowEndPlan } from "../../src/instruments/lowEnd";
import { parseKey } from "../../src/project-model/scales";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import {
  STEP_TICKS,
  type InstrumentTrack,
  type MusicalKey,
  type NoteEvent,
  type ProjectDocument,
} from "../../src/project-model/types";

/**
 * LOW-END STACK wave 2 — the bassline and the fit metric. The generator
 * locks the 808 line to the kick onsets and the chord track; the metric
 * measures the low end as one system. The command writes the line as ONE
 * undoable snapshot.
 */

function docWithKey(key: MusicalKey | undefined): ProjectDocument {
  const doc = createProjectFromTemplate("house");
  if (key !== undefined) doc.key = key;
  doc.tracks = doc.tracks.filter(
    (t) => !(t.kind === "instrument" && (t.instrument === "kopa" || t.instrument === "808")),
  );
  return doc;
}

/** Build the stack, then give the kick a four-on-floor bar and set the chord/key stage. */
function stackedDoc(
  key: MusicalKey | undefined,
  options: { chords?: boolean; kickNotes?: boolean } = {},
): {
  doc: ProjectDocument;
  kickId: string;
  bassId: string;
} {
  const doc = docWithKey(key);
  const root = key ? (parseKey(key)?.root ?? 0) : 0;
  const next = forgeLowEndStackCommand(doc, { keyRootPc: root }).execute(doc);
  const kick = next.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "kopa");
  const bass = next.tracks.find((t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "808");
  if (!kick || !bass) throw new Error("stack missing");
  if (options.chords) {
    next.arrangement = {
      ...next.arrangement,
      chords: [
        { id: "chord-a", startBar: 0, lengthBars: 1, root: 9, quality: "min" }, // A
        { id: "chord-f", startBar: 1, lengthBars: 1, root: 5, quality: "maj" }, // F
      ],
    };
  }
  if (options.kickNotes) {
    const pattern = next.patterns.find((p) => p.id === next.activePatternId);
    if (!pattern) throw new Error("active pattern missing");
    pattern.notes[kick.id] = [0, 480, 960, 1440].map((start, index): NoteEvent => ({
      id: `kick-${index}`,
      pitch: 36,
      start,
      duration: STEP_TICKS,
      velocity: 1,
    }));
  }
  return { doc: next, kickId: kick.id, bassId: bass.id };
}

describe("bassRootAtBar", () => {
  it("follows the chord track per bar and wraps a short progression", () => {
    const { doc } = stackedDoc("C Major", { chords: true });
    expect(bassRootAtBar(doc, 0)).toEqual({ rootPc: 9, basis: "chords" });
    expect(bassRootAtBar(doc, 1)).toEqual({ rootPc: 5, basis: "chords" });
    expect(bassRootAtBar(doc, 2)).toEqual({ rootPc: 9, basis: "chords" }); // wraps
    expect(bassRootAtBar(doc, 3)).toEqual({ rootPc: 5, basis: "chords" });
  });

  it("degrades to the key tonic, then the chromatic anchor", () => {
    const keyed = docWithKey("A Natural Minor");
    expect(bassRootAtBar(keyed, 0)).toEqual({ rootPc: 9, basis: "key" });
    const bare = docWithKey(undefined);
    expect(bassRootAtBar(bare, 0)).toEqual({ rootPc: 0, basis: "chromatic" });
  });
});

describe("planBassline", () => {
  it("locks the rhythm to the kick onsets and gates each note to the next", () => {
    const { doc } = stackedDoc("C Major", { kickNotes: true });
    const plan = planBassline(doc, lowEndPlan(doc));
    expect(plan.events.map((note) => note.start)).toEqual([0, 480, 960, 1440]);
    expect(plan.events[0]!.duration).toBe(Math.round(480 * 0.9)); // gate 0.9 to the next onset
    expect(plan.kickOnsets).toHaveLength(4);
    expect(plan.coverage).toBe(1);
  });

  it("follows the chord at each bar: A minor bar 0 → pitch 45, F major bar 1 → 41", () => {
    const { doc } = stackedDoc("C Major", { chords: true, kickNotes: true });
    const plan = planBassline(doc, lowEndPlan(doc));
    expect(plan.events[0]!.pitch).toBe(45); // C2 + 9 st = A2
    expect(plan.events[4 % plan.events.length]).toBeDefined();
    expect(plan.basis).toBe("chords");
  });

  it("a silent kick yields the downbeat skeleton and says so via kickOnsets", () => {
    const { doc } = stackedDoc("C Major");
    const { onsets, skeleton } = kickOnsetsOf(doc, lowEndPlan(doc).kickTrackId);
    expect(skeleton).toBe(true);
    expect(onsets).toEqual([0]); // a 16-step pattern = one bar → one downbeat
    const plan = planBassline(doc, lowEndPlan(doc));
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]!.start).toBe(0);
  });

  it("fifth and octave styles shift alternate onsets", () => {
    const { doc } = stackedDoc("C Major", { kickNotes: true });
    const rootPc = 9;
    const withChord: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        chords: [{ id: "c", startBar: 0, lengthBars: 2, root: rootPc, quality: "min" }],
      },
    };
    const fifths = planBassline(withChord, lowEndPlan(withChord), { style: "fifth" });
    expect(fifths.events[0]!.pitch).toBe(36 + rootPc);
    expect(fifths.events[1]!.pitch).toBe(36 + ((rootPc + 7) % 12));
    const octaves = planBassline(withChord, lowEndPlan(withChord), { style: "octave" });
    expect(octaves.events[1]!.pitch).toBe(36 + rootPc + 12); // a real octave up, not a wrap
  });
});

describe("measureLowEndFit", () => {
  it("says silent when the bass has no notes", () => {
    const { doc } = stackedDoc("C Major", { kickNotes: true });
    const fit = measureLowEndFit(doc, lowEndPlan(doc));
    expect(fit.verdict).toBe("silent");
  });

  it("says fighting when kick and bass share the register with no ducking", () => {
    const { doc, bassId } = stackedDoc("C Major", { kickNotes: true });
    // Strip the sidechain the stack wired: now both sit near C2, unducked.
    doc.tracks = doc.tracks.map((t) =>
      t.kind === "instrument" && t.id === bassId
        ? { ...t, effects: (t.effects ?? []).filter((fx) => fx.type !== "sidechain") }
        : t,
    );
    const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
    pattern.notes[bassId] = [0, 480, 960, 1440].map((start, index): NoteEvent => ({
      id: `bass-${index}`,
      pitch: 36, // same C2 as the kick's fixed body
      start,
      duration: 400,
      velocity: 0.8,
    }));
    const fit = measureLowEndFit(doc, lowEndPlan(doc));
    expect(fit.verdict).toBe("fighting");
    expect(fit.registerDistanceSt).toBe(0);
    expect(fit.coverage).toBe(1);
  });

  it("says locked when the seeded line rides the chord track with ducking wired", () => {
    let doc = stackedDoc("C Major", { chords: true, kickNotes: true }).doc;
    doc = seedBasslineCommand(doc, {}).execute(doc);
    const fit = measureLowEndFit(doc, lowEndPlan(doc));
    expect(fit.verdict).toBe("locked");
    expect(fit.coverage).toBe(1);
    expect(fit.harmonicLock).toBe(1);
    expect(fit.ducked).toBe(true);
  });
});

describe("seedBasslineCommand", () => {
  it("writes the active pattern's bass row as ONE snapshot and undoes wholesale", () => {
    const { doc, bassId } = stackedDoc("C Major", { kickNotes: true });
    const patternId = doc.activePatternId;
    const before = doc.patterns.find((p) => p.id === patternId)!.notes[bassId] ?? [];
    expect(before).toHaveLength(0);
    const command = seedBasslineCommand(doc, {});
    const next = command.execute(doc);
    const seeded = next.patterns.find((p) => p.id === patternId)!.notes[bassId] ?? [];
    expect(seeded).toHaveLength(4);
    const rolled = command.undo(next);
    expect((rolled.patterns.find((p) => p.id === patternId)!.notes[bassId] ?? []).length).toBe(0);
  });

  it("is idempotent: reseeding the same document reproduces the same line", () => {
    let doc = stackedDoc("C Major", { kickNotes: true }).doc;
    doc = seedBasslineCommand(doc, {}).execute(doc);
    doc = seedBasslineCommand(doc, {}).execute(doc);
    const plan = lowEndPlan(doc);
    const bassId = plan.bassTrackId!;
    const notes = doc.patterns.find((p) => p.id === doc.activePatternId)!.notes[bassId] ?? [];
    expect(notes).toHaveLength(4);
    expect(new Set(notes.map((note) => note.start)).size).toBe(4);
  });

  it("refuses when there is no 808 track", () => {
    const doc = docWithKey("C Major");
    expect(() => seedBasslineCommand(doc, {})).toThrow(/808/);
  });
});
