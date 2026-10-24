import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { ProjectStore } from "../src/store/ProjectStore";
import {
  addMidiClip,
  moveMidiClip,
  resizeMidiClip,
  trimMidiClipStart,
  splitMidiClipAtTick,
  duplicateMidiClip,
  setMidiClipMuted,
} from "../src/commands/midiClips";
import {
  addAutomationClip,
  trimAutomationClipStart,
  splitAutomationClipAtTick,
  addAutomationClipPoint,
  setAutomationClipMuted,
} from "../src/commands/automationClips";
import { automationClipEventsInWindow, midiClipEventsInWindow } from "../src/project-model/events";
import { midiPhraseLengthTicks } from "../src/project-model/midiTime";
import { STEP_TICKS, type MidiClip, type NoteEvent, type ProjectDocument } from "../src/project-model/types";

/**
 * THE AUDIBLE LEG OF THE TICK LANES — MIDI and automation.
 *
 * WHY THIS FILE EXISTS. The tick-lane matrix
 * (`tests/tick-lane-edit-matrix.test.ts`) pins the ARITHMETIC: what the phase
 * becomes, which fields a verb owns, whether undo restores the document. It
 * cannot tell whether the clip PLAYED the notes its phase points at — a
 * document can hold a perfect phase and still schedule the wrong notes, and
 * the audio lane's own matrix already showed that "the window is right" and
 * "the audio is right" are two different questions (wave 20's PCM leg).
 *
 * THE ORACLE IS THE SHARED RESOLVER, NOT A PRIVATE COPY.
 * `midiClipEventsInWindow` and `automationClipEventsInWindow` in
 * `src/project-model/events.ts` are what the LIVE scheduler, the OFFLINE
 * renderer, the automation bridge and the MIDI export all call:
 *
 *   src/scheduler/Scheduler.ts        midiClipEventsInWindow / patternBaseTickForClip
 *   src/rendering/renderer.ts          midiClipEventsInWindow / automationClipEventsInWindow
 *   src/audio-engine/automationBridge.ts  automationClipEventsInWindow
 *   src/midi/midiProject.ts            midiClipEventsInWindow / automationClipEventsInWindow
 *
 * So an assertion about their output is an assertion about WHAT THE USER
 * HEARS. The guard at the bottom of this file proves those call sites are
 * still there — a resolver nobody calls would make every assertion here
 * vacuous, and a vacuous leg is worse than no leg.
 *
 * THE FIXTURE SPEAKS. Every note of the test pattern has its own pitch, so
 * an event list can be read as a melody: pitch 60 is the first note, 62 the
 * second, and so on. A leg that could only say "some notes played" would not
 * be able to tell a trim from a restart.
 *
 * THE PHRASE IS NOT THE GRID. The pattern's last note outlives the 16-step
 * grid, so the repeat period (`midiPhraseLengthTicks`) is LONGER than the
 * grid. A resolver that repeated at the grid would play the second cycle
 * EARLY — the same class of defect wave 1 repaired in the command layer
 * (F4), now pinned on the AUDIBLE side where it actually reaches the ear.
 */

/** Four notes, each with its own pitch, on a 16-step grid (1920 ticks). */
const NOTES: NoteEvent[] = [
  { id: "n1", pitch: 60, start: 0, duration: 240, velocity: 0.8 },
  { id: "n2", pitch: 62, start: 480, duration: 240, velocity: 0.8 },
  { id: "n3", pitch: 64, start: 960, duration: 960, velocity: 0.8 },
  // The last note ENDS at 2400 — past the 1920-tick grid. The phrase must
  // therefore be longer than the grid, or the second cycle would cut it off.
  { id: "n4", pitch: 65, start: 1200, duration: 1200, velocity: 0.8 },
];

const PATTERN_ID = "pat-audible-leg";
const GRID_TICKS = 16 * STEP_TICKS;

interface MidiFixture {
  store: ProjectStore;
  clipId: string;
  trackId: string;
  patternId: string;
}

/** A store with one MIDI clip on a pattern whose notes are identifiable. */
function storeWithMidiClip(lengthTicks = GRID_TICKS): MidiFixture {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((t) => t.kind === "instrument")!;
  const doc: ProjectDocument = {
    ...base,
    patterns: [
      ...base.patterns,
      { id: PATTERN_ID, name: "Audible leg", stepCount: 16, rows: { [track.id]: [] }, notes: { [track.id]: NOTES } },
    ],
  };
  const store = new ProjectStore(doc);
  store.execute(addMidiClip(store.doc, track.id, PATTERN_ID, 0, lengthTicks));
  const clip = store.doc.arrangement.midiClips![0]!;
  return { store, clipId: clip.id, trackId: track.id, patternId: PATTERN_ID };
}

const midiOf = (store: ProjectStore, id: string): MidiClip =>
  store.doc.arrangement.midiClips!.find((c) => c.id === id)!;

/** The notes the clip actually plays, as (tick, pitch) pairs. */
function plays(store: ProjectStore, clipId: string): Array<[number, number]> {
  const clip = midiOf(store, clipId);
  return midiClipEventsInWindow(store.doc, clip, clip.startTick, clip.startTick + clip.lengthTicks).map((event) => [
    event.tick,
    event.note.pitch,
  ]);
}

describe("the MIDI lane — what the clip actually PLAYS", () => {
  it("a clip plays the pattern from its phase, and the phrase outlives the grid", () => {
    const { store, trackId, patternId } = storeWithMidiClip();
    const pattern = store.doc.patterns.find((p) => p.id === patternId)!;
    const phrase = midiPhraseLengthTicks(pattern.stepCount, pattern.notes[trackId]!);
    expect(phrase, "the phrase must be longer than the grid, or the test cannot tell them apart").toBeGreaterThan(
      GRID_TICKS,
    );

    // One cycle plus a bit: the second cycle must start at the PHRASE length.
    const long = storeWithMidiClip(phrase + 960);
    const events = midiClipEventsInWindow(long.store.doc, midiOf(long.store, long.clipId), 0, phrase + 960).map(
      (event) => [event.tick, event.note.pitch] as [number, number],
    );

    expect(events[0], "the first cycle starts with the pattern's first note").toEqual([0, 60]);
    expect(
      events.filter(([tick]) => tick < phrase).map(([, pitch]) => pitch),
      "the first cycle plays the four notes in order",
    ).toEqual([60, 62, 64, 65]);

    const secondCycle = events.filter(([tick]) => tick >= phrase);
    expect(secondCycle[0], "the pattern repeats at the PHRASE length, not at the grid").toEqual([phrase, 60]);
    expect(
      events.some(([tick]) => tick === GRID_TICKS),
      "nothing may play at the grid boundary — that is where a grid-period repeat would land",
    ).toBe(false);
  });

  it("a head trim moves the window, so the clip plays the notes the new phase points at", () => {
    const { store, clipId } = storeWithMidiClip();
    const before = plays(store, clipId);
    expect(before[0], "the untrimmed clip starts at the pattern's first note").toEqual([0, 60]);

    store.execute(trimMidiClipStart(store.doc, clipId, 480));
    const after = plays(store, clipId);
    expect(after[0], "the trimmed clip must start on the note its phase points at").toEqual([480, 62]);
    expect(
      after.some(([, pitch]) => pitch === 60),
      "the note before the trim point must not sound after the trim",
    ).toBe(false);
  });

  it("a head trim cuts the note that was already sounding — the standard DAW trim", () => {
    const { store, clipId } = storeWithMidiClip();
    // n3 sounds from 960 to 1920. Trimming the head to 1200 lands INSIDE it.
    store.execute(trimMidiClipStart(store.doc, clipId, 1200));
    const pitches = plays(store, clipId).map(([, pitch]) => pitch);
    expect(
      pitches,
      "a note whose attack lies before the trim point is cut, not re-attacked at the trim point",
    ).not.toContain(64);
    expect(pitches, "the next attack still sounds").toContain(65);
  });

  it("a split preserves every note ATTACK exactly once — no note lost, no note doubled", () => {
    const { store, clipId } = storeWithMidiClip(GRID_TICKS);
    const original = midiClipEventsInWindow(store.doc, midiOf(store, clipId), 0, GRID_TICKS);

    store.execute(splitMidiClipAtTick(store.doc, clipId, 1200));
    const fragments = [...store.doc.arrangement.midiClips!].sort((a, b) => a.startTick - b.startTick);
    expect(fragments).toHaveLength(2);

    const played = fragments.flatMap((clip) =>
      midiClipEventsInWindow(store.doc, clip, clip.startTick, clip.startTick + clip.lengthTicks),
    );
    const attacks = (events: typeof played) => events.map((event) => [event.tick, event.note.pitch]);
    expect(attacks(played), "no attack may be lost or duplicated by a split").toEqual(attacks(original));
  });

  it("a split cuts the note that was sounding across the split — the WINDOW decides", () => {
    // THE MODEL, stated so a future change cannot quietly change it: a MIDI
    // clip is a WINDOW on its pattern. A note whose ATTACK falls inside the
    // window sounds (cut at the window's end); a note whose attack falls
    // before it does not sound at all. The arrangement lane draws exactly the
    // same cut (`MidiClipNoteMarks` places a mark at the note's first offset
    // inside the window and clips its width to the window), so the picture
    // and the sound agree.
    //
    // The price: a split inside a sustained note is NOT audio-neutral the way
    // an AUDIO clip's split is — the tail belongs to the left window and the
    // right window starts a fresh cycle of the pattern. See the audit report:
    // "the MIDI lane's split is a phase split, not a buffer split".
    const { store, clipId } = storeWithMidiClip(GRID_TICKS);
    // n3 sounds 960 → 1920; the split at 1200 lands inside it.
    store.execute(splitMidiClipAtTick(store.doc, clipId, 1200));
    const fragments = [...store.doc.arrangement.midiClips!].sort((a, b) => a.startTick - b.startTick);
    const right = fragments[1]!;

    const rightEvents = midiClipEventsInWindow(store.doc, right, right.startTick, right.startTick + right.lengthTicks);
    expect(
      rightEvents.map((event) => event.note.pitch),
      "the right fragment starts a fresh cycle of the pattern",
    ).toEqual([65]);
    expect(
      rightEvents.some((event) => event.note.pitch === 64),
      "the note cut at the split is NOT re-attacked in the right fragment",
    ).toBe(false);

    // The left fragment DID play the note — up to the split.
    const leftEvents = midiClipEventsInWindow(
      store.doc,
      fragments[0]!,
      fragments[0]!.startTick,
      fragments[0]!.startTick + fragments[0]!.lengthTicks,
    );
    const leftNote = leftEvents.find((event) => event.note.pitch === 64);
    expect(leftNote, "the left fragment played the note").toBeDefined();
    expect(leftNote!.note.duration, "the note is cut at the split point").toBe(1200 - 960);

    // The measured size of the price: the note is 960 ticks long, and after
    // the split only 240 of them are heard.
    const soundedTicks = [...fragments]
      .flatMap((clip) => midiClipEventsInWindow(store.doc, clip, clip.startTick, clip.startTick + clip.lengthTicks))
      .filter((event) => event.note.pitch === 64)
      .reduce((sum, event) => sum + event.note.duration, 0);
    expect(soundedTicks, "the sustain after the split is silent").toBe(240);
  });

  it("a note that outlives the clip is cut at the clip's end", () => {
    const { store, clipId } = storeWithMidiClip(1200);
    const clip = midiOf(store, clipId);
    const events = midiClipEventsInWindow(store.doc, clip, clip.startTick, clip.startTick + clip.lengthTicks);
    const n3 = events.find((event) => event.note.pitch === 64);
    expect(n3, "the long note is heard").toBeDefined();
    expect(n3!.note.duration, "the note is cut at the clip end").toBe(1200 - 960);
  });

  it("a muted clip plays nothing, and a duplicate plays the same notes at its own place", () => {
    const { store, clipId } = storeWithMidiClip();
    const original = plays(store, clipId);

    store.execute(setMidiClipMuted(store.doc, clipId, true));
    expect(plays(store, clipId), "a muted clip is silent").toEqual([]);
    store.execute(setMidiClipMuted(store.doc, clipId, false));

    store.execute(duplicateMidiClip(store.doc, clipId));
    const copy = store.doc.arrangement.midiClips!.find((c) => c.id !== clipId)!;
    const copied = midiClipEventsInWindow(store.doc, copy, copy.startTick, copy.startTick + copy.lengthTicks).map(
      (event) => [event.tick, event.note.pitch] as [number, number],
    );
    const shift = copy.startTick - midiOf(store, clipId).startTick;
    expect(copied, "the copy plays the same notes, shifted onto its own timeline").toEqual(
      original.map(([tick, pitch]) => [tick + shift, pitch]),
    );
  });

  it("a move does not change a single note — the clip takes its content with it", () => {
    const { store, clipId } = storeWithMidiClip();
    const before = plays(store, clipId);
    store.execute(moveMidiClip(store.doc, clipId, 480));
    const after = plays(store, clipId);
    expect(after, "the notes keep their pitches").toEqual(before.map(([tick, pitch]) => [tick + 480, pitch]));
  });

  it("a resize cuts the notes that fall outside the new window", () => {
    const { store, clipId } = storeWithMidiClip();
    store.execute(resizeMidiClip(store.doc, clipId, 300));
    const pitches = plays(store, clipId).map(([, pitch]) => pitch);
    expect(pitches, "only the notes inside the window sound").toEqual([60]);
  });
});

interface AutoFixture {
  store: ProjectStore;
  clipId: string;
  trackId: string;
}

/** A store with one automation clip whose curve is steep at the split point. */
function storeWithAutomationClip(): AutoFixture {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((t) => t.kind === "instrument")!;
  const store = new ProjectStore(base);
  store.execute(
    addAutomationClip(store.doc, { kind: "trackGain", trackId: track.id }, 0, 1920, [
      { tick: 0, value: 0.2 },
      { tick: 960, value: 0.8 },
      { tick: 1920, value: 0.4 },
    ]),
  );
  const clip = store.doc.arrangement.automationClips![0]!;
  return { store, clipId: clip.id, trackId: track.id };
}

const autoOf = (store: ProjectStore, id: string) => store.doc.arrangement.automationClips!.find((c) => c.id === id)!;

/** The curve values the target actually receives, as (tick, value) pairs. */
function drives(store: ProjectStore, clipId: string): Array<[number, number]> {
  const clip = autoOf(store, clipId);
  return automationClipEventsInWindow(clip, clip.startTick, clip.startTick + clip.lengthTicks).map((event) => [
    event.tick,
    event.value,
  ]);
}

describe("the automation lane — what the target actually RECEIVES", () => {
  it("the visible window reads the SOURCE curve at the phase", () => {
    const { store, clipId } = storeWithAutomationClip();
    const events = drives(store, clipId);
    expect(events[0], "the lane starts at the curve's first point").toEqual([0, 0.2]);
    expect(events[1], "the interior point is heard at its source tick").toEqual([960, 0.8]);
    expect(events[2], "the lane ends on the curve's last point").toEqual([1920, 0.4]);
  });

  it("a head trim advances the phase, so the lane starts on the curve BEHIND the window", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(trimAutomationClipStart(store.doc, clipId, 480));
    const clip = autoOf(store, clipId);
    expect(clip.phaseOffsetTicks, "the phase carries the trim").toBe(480);
    const events = drives(store, clipId);
    expect(events[0]?.[0], "the lane starts at the trimmed start").toBe(480);
    // Source tick 480 sits between 0 (0.2) and 960 (0.8) → 0.2 + 0.5 * (0.8 - 0.2) = 0.5.
    expect(events[0]?.[1], "the value is read at the source tick behind the window").toBeCloseTo(0.5, 6);
  });

  it("a split is audible-neutral: the fragments' curve tiles the original's", () => {
    const { store, clipId } = storeWithAutomationClip();
    const original = drives(store, clipId);

    store.execute(splitAutomationClipAtTick(store.doc, clipId, 960));
    const fragments = [...store.doc.arrangement.automationClips!].sort((a, b) => a.startTick - b.startTick);
    expect(fragments).toHaveLength(2);

    const left = drives(store, fragments[0]!.id);
    const right = drives(store, fragments[1]!.id);
    expect(left[0], "the left fragment starts on the curve").toEqual([0, 0.2]);
    expect(right[0], "the right fragment starts on the curve at the split").toEqual([960, 0.8]);
    expect(right[right.length - 1], "the right fragment ends on the curve's last point").toEqual([1920, 0.4]);
    expect(left[left.length - 1]?.[1], "the seam must be continuous: the curve may not jump at the split").toBe(
      right[0]?.[1],
    );
    expect(original, "the control: the unsplit lane read the same curve").toHaveLength(3);
  });

  it("a point the user adds at visible tick 0 is heard at the SOURCE tick behind the phase", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(trimAutomationClipStart(store.doc, clipId, 480));
    store.execute(addAutomationClipPoint(store.doc, clipId, 0, 0.55));
    const events = drives(store, clipId);
    expect(events[0]?.[0], "the new point is heard at the visible start").toBe(480);
    expect(events[0]?.[1], "and it carries the user's value").toBeCloseTo(0.55, 6);
  });

  it("a muted lane drives nothing", () => {
    const { store, clipId } = storeWithAutomationClip();
    store.execute(setAutomationClipMuted(store.doc, clipId, true));
    expect(drives(store, clipId), "a muted lane sends no values").toEqual([]);
  });
});

/**
 * THE GUARD: the audible paths resolve the tick lanes through the SHARED
 * resolver. Without it, this file would measure a function that nothing
 * calls — a leg that cannot fail.
 *
 * The check is an AST walk, not a grep: a grep for the resolver's NAME would
 * also match a comment or an import that is never called. The house rule (see
 * `tests/adr0056-stage2-bar-formula-guard.test.ts`) is that a guard must be
 * PROVEN ABLE TO FAIL — the detector is fed synthetic sources below and must
 * report them.
 */
const RESOLVER_CALL_SITES: Array<{ file: string; resolver: string }> = [
  { file: "src/scheduler/Scheduler.ts", resolver: "midiClipEventsInWindow" },
  { file: "src/rendering/renderer.ts", resolver: "midiClipEventsInWindow" },
  { file: "src/rendering/renderer.ts", resolver: "automationClipEventsInWindow" },
  { file: "src/audio-engine/automationBridge.ts", resolver: "automationClipEventsInWindow" },
  { file: "src/midi/midiProject.ts", resolver: "midiClipEventsInWindow" },
  { file: "src/midi/midiProject.ts", resolver: "automationClipEventsInWindow" },
];

/** True when `source` CALLS `resolver` (an identifier used as a callee). */
function callsResolver(source: string, resolver: string): boolean {
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === resolver) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the guard: the audible paths use the SHARED resolver", () => {
  it("the detector is proven able to fail", () => {
    expect(
      callsResolver(`const x = 1; // midiClipEventsInWindow is only a comment here`, "midiClipEventsInWindow"),
      "a comment must not count as a call",
    ).toBe(false);
    expect(
      callsResolver(`import { midiClipEventsInWindow } from "./events";`, "midiClipEventsInWindow"),
      "an unused import must not count as a call",
    ).toBe(false);
    expect(
      callsResolver(`const events = midiClipEventsInWindow(doc, clip, 0, 120);`, "midiClipEventsInWindow"),
      "a real call must be found",
    ).toBe(true);
  });

  it.each(RESOLVER_CALL_SITES)("$file resolves through $resolver", ({ file, resolver }) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(
      callsResolver(source, resolver),
      `${file} must resolve the tick lanes through ${resolver} — otherwise the audible leg measured here is not what the user hears`,
    ).toBe(true);
  });
});
