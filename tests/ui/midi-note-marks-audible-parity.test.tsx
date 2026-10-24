import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { MidiClipLanes } from "../../src/ui/arrangement/MidiClipLanes";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { midiClipEventsInWindow } from "../../src/project-model/events";
import { addMidiClip, splitMidiClipAtTick } from "../../src/commands/midiClips";
import { STEP_TICKS, type MidiClip, type NoteEvent, type ProjectDocument } from "../../src/project-model/types";

/**
 * THE DRAWN LEG AND THE HEARD LEG MUST AGREE.
 *
 * The arrangement lane draws a MIDI clip's notes as small marks
 * (`MidiClipNoteMarks`): one mark per note occurrence inside the clip's
 * window, placed at the note's first offset inside that window and clipped to
 * the window's width. The scheduler plays the clip's notes
 * (`midiClipEventsInWindow`). Those are two independent implementations of the
 * same idea — "which notes of the pattern does this clip show and play" — and
 * the audit's audio-integrity axis asks for exactly one thing about such a
 * pair: they must not drift.
 *
 * The drift this file would catch: the lane drawing a note the scheduler does
 * not play (a note the user sees but never hears), or the scheduler playing a
 * note the lane does not draw (a sound with no picture). Either one is the
 * MIDI-lane version of "the waveform and the audio are out of sync", and
 * neither is visible in the document — only in the two legs side by side.
 *
 * The fixture is the same four identifiable notes the audible-leg suite uses,
 * so a mark can be matched to a note by its pitch.
 */

const NOTES: NoteEvent[] = [
  { id: "n1", pitch: 60, start: 0, duration: 240, velocity: 0.8 },
  { id: "n2", pitch: 62, start: 480, duration: 240, velocity: 0.8 },
  { id: "n3", pitch: 64, start: 960, duration: 960, velocity: 0.8 },
  { id: "n4", pitch: 65, start: 1200, duration: 1200, velocity: 0.8 },
];

const PATTERN_ID = "pat-draw-parse-parity";
const GRID_TICKS = 16 * STEP_TICKS;

function docWithMidiClip(lengthTicks: number): { doc: ProjectDocument; clip: MidiClip } {
  const base = createProjectFromTemplate("house");
  const track = base.tracks.find((candidate) => candidate.kind === "instrument")!;
  const doc: ProjectDocument = {
    ...base,
    patterns: [
      ...base.patterns,
      { id: PATTERN_ID, name: "Parity", stepCount: 16, rows: { [track.id]: [] }, notes: { [track.id]: NOTES } },
    ],
    arrangement: { ...base.arrangement, midiClips: [] },
  };
  const withClip = addMidiClip(doc, track.id, PATTERN_ID, 0, lengthTicks).execute(doc);
  return { doc: withClip, clip: withClip.arrangement.midiClips![0]! };
}

/** The note marks the lane drew for the clip, in ticks. */
function drawnMarks(container: HTMLElement, clip: MidiClip): Array<{ tick: number; duration: number }> {
  return [...container.querySelectorAll(".arr-midi-note-mark")].map((element) => {
    const style = (element as HTMLElement).style;
    const left = parseFloat(style.left);
    const width = parseFloat(style.width);
    return {
      tick: clip.startTick + (left / 100) * clip.lengthTicks,
      duration: (width / 100) * clip.lengthTicks,
    };
  });
}

/** The notes the scheduler plays for the clip, in ticks. */
function playedNotes(doc: ProjectDocument, clip: MidiClip): Array<{ tick: number; duration: number }> {
  return midiClipEventsInWindow(doc, clip, clip.startTick, clip.startTick + clip.lengthTicks).map((event) => ({
    tick: event.tick,
    duration: event.note.duration,
  }));
}

function renderLanes(doc: ProjectDocument, clips: MidiClip[]): HTMLElement {
  const { container } = render(
    createElement(MidiClipLanes, {
      doc,
      tracks: doc.tracks,
      midiClips: clips,
      selectedClipIds: [],
      totalBars: 64,
      barWidth: 30,
      snapGrid: "off",
      playheadTick: 0,
      onExecute: () => true,
      onSelect: () => {},
      onEditSource: () => {},
      onMakeUniqueAndEdit: () => {},
    }),
  );
  return container;
}

/** The marks and the events must line up, tick for tick. */
function expectParity(doc: ProjectDocument, clip: MidiClip, container: HTMLElement, label: string): void {
  const drawn = drawnMarks(container, clip);
  const played = playedNotes(doc, clip);
  expect(drawn.length, `${label}: the lane draws a different number of notes than the scheduler plays`).toBe(
    played.length,
  );
  for (let index = 0; index < played.length; index++) {
    expect(drawn[index]!.tick, `${label}: mark ${index} sits at a different tick than the note it draws`).toBeCloseTo(
      played[index]!.tick,
      3,
    );
    expect(drawn[index]!.duration, `${label}: mark ${index} is a different length than the note it draws`).toBeCloseTo(
      played[index]!.duration,
      3,
    );
  }
}

describe("the MIDI lane — the drawn leg and the heard leg", () => {
  afterEach(() => cleanup());

  it("draws exactly the notes the scheduler plays", () => {
    const { doc, clip } = docWithMidiClip(GRID_TICKS);
    const container = renderLanes(doc, [clip]);
    expectParity(doc, clip, container, "whole clip");
    expect(drawnMarks(container, clip).length, "the clip draws its four notes").toBe(4);
  });

  it("draws and plays the same cut after a split", () => {
    const { doc, clip } = docWithMidiClip(GRID_TICKS);
    // The split lands inside n3 (960 → 1920), so the note is cut.
    const split = splitMidiClipAtTick(doc, clip.id, 1200).execute(doc);
    const fragments = [...split.arrangement.midiClips!].sort((a, b) => a.startTick - b.startTick);
    expect(fragments).toHaveLength(2);

    for (const fragment of fragments) {
      const container = renderLanes(split, [fragment]);
      expectParity(split, fragment, container, `fragment at ${fragment.startTick}`);
    }
  });

  it("a trim moves the window in BOTH legs at once", () => {
    const { doc, clip } = docWithMidiClip(GRID_TICKS);
    const trimmed: ProjectDocument = {
      ...doc,
      arrangement: {
        ...doc.arrangement,
        midiClips: [{ ...clip, startTick: 480, lengthTicks: GRID_TICKS - 480, phaseOffsetTicks: 480 }],
      },
    };
    const container = renderLanes(trimmed, [trimmed.arrangement.midiClips![0]!]);
    expectParity(trimmed, trimmed.arrangement.midiClips![0]!, container, "trimmed clip");
  });
});
