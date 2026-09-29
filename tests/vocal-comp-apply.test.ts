import { describe, it, expect } from "vitest";
import { applyVocalCompCommand } from "../src/vocal/comp-apply";
import { planVocalComp } from "../src/vocal/comping";
import { testDoc } from "./fixtures/doc";
import type { VocalProfile, VocalPhrase } from "../src/vocal/types";

/**
 * VOCAL COMP APPLY — the plan becomes tracks: one vocalchop per
 * contributing take, notes only in the winning bar spans, ONE undo step,
 * re-apply replaces instead of stacking. Honest throws for unstaged takes.
 */

function profile(bars: number, phrases: VocalPhrase[], energyAt: (bar: number) => number): VocalProfile {
  return {
    version: 1,
    key: null,
    keyConfidence: 0,
    keyMeasured: false,
    tempoBpm: null,
    tempoConfidence: 0,
    tempoMeasured: false,
    energyCurve: Array.from({ length: bars }, (_, bar) => energyAt(bar)),
    phrases,
    silenceRatio: 0,
    snrDb: 30,
    durationSec: bars * 2,
    bars,
    bpm: 120,
    measured: true,
    profileHash: `hash-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function phrase(startBar: number, endBar: number, peakEnergy = 0.8): VocalPhrase {
  return { startBar, endBar, peakEnergy };
}

const TAKES = [
  { bufferId: "buf-a", profile: profile(8, [phrase(0, 3, 0.9)], (bar) => (bar <= 3 ? 0.9 : 0)) },
  { bufferId: "buf-b", profile: profile(8, [phrase(4, 7, 0.95)], (bar) => (bar >= 4 ? 0.95 : 0)) },
];

describe("applyVocalCompCommand", () => {
  it("creates one vocalchop track per contributing take, notes only in winning spans", () => {
    const doc = testDoc();
    const plan = planVocalComp(TAKES.map((t) => t.profile))!;
    const cmd = applyVocalCompCommand(doc, TAKES, plan);
    const next = cmd.execute(doc);

    const comps = next.tracks.filter((t): t is import("../src/project-model/types").InstrumentTrack =>
      t.name.startsWith("Comp — voice "),
    );
    expect(comps).toHaveLength(2);
    // Take A wins bars 0-3 → its track carries the opening notes
    const trackA = comps.find((t) => t.sampleId === "buf-a")!;
    const notesA = next.patterns.find((p) => p.id === doc.activePatternId)!.notes[trackA.id] ?? [];
    expect(notesA.length).toBeGreaterThan(0);
    // every note starts inside its take's winning span (first half for A)
    for (const note of notesA) {
      expect(note.start).toBeLessThan((next.patterns[0]!.stepCount / 8) * 4 * 30);
    }
  });

  it("one undo step restores tracks and notes", () => {
    const doc = testDoc();
    const plan = planVocalComp(TAKES.map((t) => t.profile))!;
    const cmd = applyVocalCompCommand(doc, TAKES, plan);
    const next = cmd.execute(doc);
    expect(next.tracks.length).toBeGreaterThan(doc.tracks.length);
    const undone = cmd.undo(next);
    expect(undone.tracks.length).toBe(doc.tracks.length);
    expect(undone).toEqual(doc);
  });

  it("re-apply replaces the previous comp tracks instead of stacking", () => {
    const doc = testDoc();
    const plan = planVocalComp(TAKES.map((t) => t.profile))!;
    const once = applyVocalCompCommand(doc, TAKES, plan).execute(doc);
    const compCount = (d: typeof doc) => d.tracks.filter((t) => t.name.startsWith("Comp — voice ")).length;
    expect(compCount(once)).toBe(2);
    const twice = applyVocalCompCommand(once, TAKES, plan).execute(once);
    expect(compCount(twice)).toBe(2); // replaced, not stacked
  });

  it("throws honestly when a contributing take is not staged", () => {
    const doc = testDoc();
    const plan = planVocalComp(TAKES.map((t) => t.profile))!;
    expect(() => applyVocalCompCommand(doc, [{ bufferId: "", profile: TAKES[0]!.profile }, TAKES[1]!], plan)).toThrow(
      /not staged/,
    );
  });
});
