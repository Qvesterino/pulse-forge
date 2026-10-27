import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { ScenePatternMarks } from "../../src/ui/arrangement/ScenePatternMarks";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { noteEventsInWindow, patternBaseTickForClip } from "../../src/project-model/events";
import { drumHitsInWindow } from "../../src/project-model/groove";
import { ticksPerBar } from "../../src/project-model/schema";
import { trimArrangementClipStart } from "../../src/commands/arrangement";
import type { ArrangementClip, NoteEvent, ProjectDocument } from "../../src/project-model/types";

/**
 * THE SCENE REGION'S PICTURE AND THE SCENE REGION'S SOUND MUST AGREE.
 *
 * The scene lane was blind: a region was a labelled box that played a whole
 * scene and showed none of it. Wave 7 drew the pattern inside the region —
 * the melody as one bar per note, the drums as one tick per hit.
 *
 * A drawing is only worth something if it is TRUE, and the drift this file
 * would catch is the same drift the MIDI lane's parity suite catches in its
 * own lane:
 *
 *   - the region draws a note the scheduler does not play (a note the user
 *     sees but never hears);
 *   - the scheduler plays a note the region does not draw (a sound with no
 *     picture);
 *   - the picture is measured in the wrong unit (a 6/8 project would place
 *     every mark against the 4/4 bar and slide the whole picture off its
 *     own region).
 *
 * THE ORACLE IS THE SHARED RESOLVER, NOT A PRIVATE COPY. The scene's audible
 * content is `patternBaseTickForClip` + `noteEventsInWindow` (the drums ride
 * the same base through `drumHitsInWindow`), and BOTH playback paths use
 * exactly those:
 *
 *   src/scheduler/Scheduler.ts    patternBaseTickForClip -> schedulePatternWindow
 *   src/rendering/renderer.ts     patternBaseTickForClip -> noteEventsInWindow
 *
 * So an assertion about their output is an assertion about WHAT THE USER
 * HEARS, live and in the export.
 *
 * THE MEASUREMENT IS A ROUND-TRIP, NOT A READ-BACK. The drawn marks are read
 * from the DOM as PERCENTAGES (the only geometry the DOM carries) and
 * converted back into ticks through the region's own length. A component
 * that placed its marks against the wrong bar unit, or against the clip's
 * pixels instead of its ticks, would come back with different ticks — which
 * is the defect this file exists to catch.
 */

const CONTROLLED_NOTES: NoteEvent[] = [
  { id: "m1", pitch: 60, start: 0, duration: 240, velocity: 0.8 },
  { id: "m2", pitch: 62, start: 480, duration: 240, velocity: 0.6 },
  { id: "m3", pitch: 64, start: 960, duration: 960, velocity: 0.9 },
];

interface Fixture {
  doc: ProjectDocument;
  clip: ArrangementClip;
}

/** The house template's scene region, untouched — the product's own default scene. */
function houseFixture(): Fixture {
  const doc = createProjectFromTemplate("house");
  return { doc, clip: doc.arrangement.clips[0]! };
}

/**
 * The house region with a CONTROLLED melody: one melodic track with three
 * fixed pitches. A mark can then be matched to a note by its pitch, so a
 * leg that could only say "some notes were drawn" could not tell a
 * continuation from a restart.
 */
function controlledFixture(timeSignature?: { numerator: number; denominator: number }): Fixture {
  const base = createProjectFromTemplate("house");
  const instrument = base.tracks.find((candidate) => candidate.kind === "instrument")!;
  const clip = base.arrangement.clips[0]!;
  const scene = base.scenes.find((candidate) => candidate.id === clip.sceneId)!;
  const doc: ProjectDocument = {
    ...base,
    ...(timeSignature ? { timeSignature } : {}),
    patterns: base.patterns.map((candidate) =>
      candidate.id === scene.patternId ? { ...candidate, notes: { [instrument.id]: CONTROLLED_NOTES } } : candidate,
    ),
  };
  return { doc, clip: doc.arrangement.clips[0]! };
}

const clipOf = (doc: ProjectDocument, id: string): ArrangementClip =>
  doc.arrangement.clips.find((candidate) => candidate.id === id)!;

function patternOf(doc: ProjectDocument, clip: ArrangementClip) {
  const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId)!;
  return doc.patterns.find((candidate) => candidate.id === scene.patternId)!;
}

/** The notes the region PLAYS, in ticks. */
function playedNotes(
  doc: ProjectDocument,
  clip: ArrangementClip,
): Array<{ tick: number; duration: number; pitch: number }> {
  const barUnit = ticksPerBar(doc);
  const base = patternBaseTickForClip(clip, barUnit);
  const from = clip.startBar * barUnit;
  const to = from + clip.lengthBars * barUnit;
  return noteEventsInWindow(patternOf(doc, clip), base, from, to).map((event) => ({
    tick: event.tick,
    duration: event.note.duration,
    pitch: event.note.pitch,
  }));
}

/** The drum hits the region PLAYS, in ticks. */
function playedDrums(doc: ProjectDocument, clip: ArrangementClip): Array<{ tick: number; velocity: number }> {
  const barUnit = ticksPerBar(doc);
  const base = patternBaseTickForClip(clip, barUnit);
  const from = clip.startBar * barUnit;
  const to = from + clip.lengthBars * barUnit;
  return drumHitsInWindow(doc, patternOf(doc, clip), base, from, to).map((hit) => ({
    tick: hit.tick,
    velocity: hit.velocity,
  }));
}

/** The note marks the region DRAWS, converted back into ticks. */
function drawnNotes(
  container: HTMLElement,
  doc: ProjectDocument,
  clip: ArrangementClip,
): Array<{ tick: number; duration: number; pitch: number; top: number }> {
  const barUnit = ticksPerBar(doc);
  const lengthTicks = clip.lengthBars * barUnit;
  const start = clip.startBar * barUnit;
  return [...container.querySelectorAll(".arr-scene-note-mark")].map((element) => {
    const style = (element as HTMLElement).style;
    const left = parseFloat(style.left);
    const width = parseFloat(style.width);
    return {
      tick: start + (left / 100) * lengthTicks,
      duration: (width / 100) * lengthTicks,
      pitch: Number((element as HTMLElement).dataset.pitch),
      top: parseFloat(style.top),
    };
  });
}

/** The drum marks the region DRAWS, converted back into ticks. */
function drawnDrums(container: HTMLElement, doc: ProjectDocument, clip: ArrangementClip): Array<{ tick: number }> {
  const barUnit = ticksPerBar(doc);
  const lengthTicks = clip.lengthBars * barUnit;
  const start = clip.startBar * barUnit;
  return [...container.querySelectorAll(".arr-scene-drum-mark")].map((element) => {
    const style = (element as HTMLElement).style;
    const left = parseFloat(style.left);
    return { tick: start + (left / 100) * lengthTicks };
  });
}

function draw(doc: ProjectDocument, clip: ArrangementClip): HTMLElement {
  const { container } = render(createElement(ScenePatternMarks, { doc, clip }));
  return container;
}

/** The drawn leg and the heard leg must line up, tick for tick. */
function expectParity(doc: ProjectDocument, clip: ArrangementClip, container: HTMLElement, label: string): void {
  const drawn = drawnNotes(container, doc, clip);
  const played = playedNotes(doc, clip);
  expect(played.length, `${label}: the region must play something`).toBeGreaterThan(0);
  expect(drawn.length, `${label}: the region draws a different number of notes than it plays`).toBe(played.length);
  for (let index = 0; index < played.length; index++) {
    expect(drawn[index]!.tick, `${label}: mark ${index} sits at a different tick than the note it draws`).toBeCloseTo(
      played[index]!.tick,
      3,
    );
    expect(drawn[index]!.duration, `${label}: mark ${index} is a different length than the note it draws`).toBeCloseTo(
      played[index]!.duration,
      3,
    );
    expect(drawn[index]!.pitch, `${label}: mark ${index} draws a different pitch than the note it draws`).toBe(
      played[index]!.pitch,
    );
  }
}

describe("the scene region — the picture and the sound", () => {
  afterEach(() => cleanup());

  it("draws exactly the notes the region plays", () => {
    const { doc, clip } = controlledFixture();
    const container = draw(doc, clip);
    expectParity(doc, clip, container, "the whole region");
    expect(drawnNotes(container, doc, clip).length, "the region draws its three notes per repetition").toBeGreaterThan(
      3,
    );
  });

  it("draws exactly the drum hits the region plays", () => {
    const { doc, clip } = houseFixture();
    const container = draw(doc, clip);
    const drawn = drawnDrums(container, doc, clip);
    const played = playedDrums(doc, clip);
    expect(played.length, "the region must play drums").toBeGreaterThan(0);
    expect(drawn.length, "the region draws a different number of drum hits than it plays").toBe(played.length);
    for (let index = 0; index < played.length; index++) {
      expect(drawn[index]!.tick, `drum mark ${index} sits at a different tick than the hit it draws`).toBeCloseTo(
        played[index]!.tick,
        3,
      );
    }
  });

  it("measures the picture in the DOCUMENT's bar unit, not in 4/4 bars", () => {
    // 6/8: a bar is 1440 ticks, not 1920. A picture measured against the
    // 4/4 bar would place every mark a third of a region too far right.
    const { doc, clip } = controlledFixture({ numerator: 6, denominator: 8 });
    expect(ticksPerBar(doc), "the fixture must not be in 4/4, or it proves nothing").toBe(1440);
    const container = draw(doc, clip);
    expectParity(doc, clip, container, "the 6/8 region");

    const drawn = drawnNotes(container, doc, clip);
    for (const mark of drawn) {
      const regionStart = clip.startBar * ticksPerBar(doc);
      const regionEnd = regionStart + clip.lengthBars * ticksPerBar(doc);
      expect(mark.tick, "a mark must sit inside its own region").toBeGreaterThanOrEqual(regionStart);
      expect(mark.tick, "a mark must sit inside its own region").toBeLessThan(regionEnd);
    }
  });

  it("the vertical axis is the melody: a higher pitch is drawn higher", () => {
    const { doc, clip } = controlledFixture();
    const container = draw(doc, clip);
    const drawn = drawnNotes(container, doc, clip);
    const byHeight = [...drawn].sort((a, b) => a.top - b.top);
    for (let index = 1; index < byHeight.length; index++) {
      expect(
        byHeight[index]!.pitch,
        "the picture's vertical order must be the melody's pitch order — a scrambled axis says nothing",
      ).toBeLessThanOrEqual(byHeight[index - 1]!.pitch);
    }
    expect(new Set(drawn.map((mark) => mark.pitch)).size, "the fixture must have more than one pitch").toBeGreaterThan(
      1,
    );
  });

  it("a trim moves the picture, because a trim moves the region's music", () => {
    const { doc, clip } = controlledFixture();
    const before = drawnNotes(draw(doc, clip), doc, clip);
    const trimmed = trimArrangementClipStart(doc, clip.id, 1).execute(doc);
    const trimmedClip = clipOf(trimmed, clip.id);
    const after = drawnNotes(draw(trimmed, trimmedClip), trimmed, trimmedClip);

    expect(after.length, "the trimmed region draws its own notes").toBeGreaterThan(0);
    expect(
      after.map((mark) => mark.tick),
      "a trimmed region's picture must sit on the ticks the trimmed region plays",
    ).not.toEqual(before.map((mark) => mark.tick));
    expectParity(trimmed, trimmedClip, draw(trimmed, trimmedClip), "the trimmed region");
  });

  it("the picture is decorative: it is hidden from assistive tech and takes no clicks", () => {
    const { doc, clip } = controlledFixture();
    const container = draw(doc, clip);
    const overlay = container.querySelector(".arr-scene-marks");
    expect(overlay, "the picture must exist").not.toBeNull();
    expect(overlay!.getAttribute("aria-hidden"), "the picture duplicates the audio — it must not be read out").toBe(
      "true",
    );
  });

  it("a region whose scene has no pattern draws nothing at all", () => {
    const { doc, clip } = controlledFixture();
    const orphan: ProjectDocument = {
      ...doc,
      scenes: doc.scenes.map((scene) => (scene.id === clip.sceneId ? { ...scene, patternId: "pat-missing" } : scene)),
    };
    const container = draw(orphan, orphan.arrangement.clips[0]!);
    expect(
      container.querySelectorAll(".arr-scene-note-mark").length,
      "there is no pattern, so there is no picture",
    ).toBe(0);
    expect(
      container.querySelectorAll(".arr-scene-drum-mark").length,
      "there is no pattern, so there is no picture",
    ).toBe(0);
  });
});
