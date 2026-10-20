/**
 * ADR 0056 — Stage 2: the arrangement's bar unit follows the document's meter.
 *
 * Before Stage 2 the arrangement converted a bar index to ticks with the
 * hardcoded `BAR_TICKS` (four quarter notes) while the metronome and the bar
 * readout used the document's meter. On a 6/8 or 3/4 document the two
 * disagreed by 960 ticks — two beats — so an audio clip placed at bar 2 started
 * two beats after the bar-2 downbeat the user heard.
 *
 * These specs pin the fix on the AUDIBLE path:
 *   - where a clip sits on the arrangement grid,
 *   - how long the render is,
 *   - how long one bar actually lasts,
 *   - where the metronome's downbeat falls, which used to be measured against
 *     a different bar than the playback click two lines away (Scheduler.ts).
 *
 * The 4/4 case is the negative control and it is not optional: a bar-unit
 * change that moved 4/4 would be a regression in every existing project.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject, ticksPerBar } from "../src/project-model/schema";
import type { ProjectDocument, TimeSignature } from "../src/project-model/types";
import { addAudioClip } from "../src/commands/commands";
import { audioClipDurationSec } from "../src/commands/audioClips";
import { computeRenderTicks } from "../src/rendering/renderer";
import { Scheduler } from "../src/scheduler/Scheduler";
import { Transport } from "../src/transport/Transport";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };

/** A 6/8 bar is three quarter notes; a 4/4 bar is four. */
const SIX_EIGHT_BAR_TICKS = 1440;
const FOUR_FOUR_BAR_TICKS = 1920;

function docWithMeter(sig: TimeSignature): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("house"),
    timeSignature: sig,
    bpm: 120,
    arrangement: { clips: [] },
  });
}

/** The house template with one audio clip at `startBar`, spanning `lengthBars`. */
function docWithAudioClip(sig: TimeSignature, startBar: number, lengthBars: number): ProjectDocument {
  const base = docWithMeter(sig);
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  return normalizeProject(addAudioClip(base, trackId, "bufStage2", startBar, lengthBars, {}).execute(base));
}

/**
 * A scheduler that only records the metronome. The count-in click pattern is
 * the observable: the lead-in used to measure 4/4 bars while the playback
 * click measured the document's meter, so in 6/8 the accent landed on the
 * wrong beat.
 */
function clickPattern(doc: ProjectDocument, countInBars: number): boolean[] {
  const clicks: { when: number; downbeat: boolean }[] = [];
  let audioTime = 10;
  const transport = new Transport({ now: () => audioTime }, doc.bpm);
  transport.setBarTicks(ticksPerBar(doc));
  const scheduler = new Scheduler({
    getProject: () => doc,
    getTransport: () => transport,
    getAudioTime: () => audioTime,
    getMode: () => "pattern",
    trigger: () => {},
    noteOn: () => {},
    applyAutomation: () => {},
    applyArrangementAutomationClip: () => {},
    applyPatternLaunch: () => {},
    metronomeClick: (when: number, downbeat: boolean) => {
      clicks.push({ when, downbeat });
    },
    triggerAudioClip: () => {},
  });
  transport.setCountIn(countInBars);
  transport.play(0);
  scheduler.start();
  for (let i = 0; i < 200; i++) {
    audioTime += 0.025;
    scheduler["tick"]();
  }
  scheduler.stop();
  return clicks.map((click) => click.downbeat);
}

describe("ADR 0056 Stage 2 — the bar unit follows the meter", () => {
  it("NEGATIVE CONTROL: a 4/4 document does not move at all", () => {
    const doc = docWithAudioClip(FOUR_FOUR, 2, 2);
    expect(ticksPerBar(doc)).toBe(FOUR_FOUR_BAR_TICKS);
    // A clip at bar 2 spanning 2 bars ends at bar 4 = tick 7680.
    expect(computeRenderTicks(doc, "song")).toBe(4 * FOUR_FOUR_BAR_TICKS);
    // One bar is four quarter notes: at 120 BPM that is two seconds.
    expect(audioClipDurationSec(doc, 1)).toBeCloseTo(2, 6);
  });

  it("places a clip on the MUSICAL bar of a 6/8 document", () => {
    const doc = docWithAudioClip(SIX_EIGHT, 2, 2);
    expect(ticksPerBar(doc)).toBe(SIX_EIGHT_BAR_TICKS);
    // Bar 2 + 2 bars = bar 4 of 6/8 = tick 5760. Under the old 4/4 unit this
    // was 7680 — two beats of drift to the right of the music.
    expect(computeRenderTicks(doc, "song")).toBe(4 * SIX_EIGHT_BAR_TICKS);
    // One 6/8 bar is three quarter notes: at 120 BPM that is 1.5 seconds.
    expect(audioClipDurationSec(doc, 1)).toBeCloseTo(1.5, 6);
  });

  it("measures the count-in downbeat in the document's bar, not in 4/4", () => {
    // A 6/8 bar is six eighth-note beats. Over a two-bar lead-in the accent
    // must fall on beats 1 and 7. The old code counted 4/4 bars, so it fell on
    // beats 1 and 9 — one accent a full bar late, and never on the bar line
    // the arrangement was drawing.
    const pattern = clickPattern(docWithMeter(SIX_EIGHT), 2);
    const downbeats = pattern.reduce<number[]>((acc, downbeat, index) => (downbeat ? [...acc, index + 1] : acc), []);
    expect(downbeats).toEqual([1, 7]);
  });

  it("keeps the 4/4 count-in accent where it was", () => {
    // The negative control for the click: four quarter-note beats per bar.
    const pattern = clickPattern(docWithMeter(FOUR_FOUR), 2);
    const downbeats = pattern.reduce<number[]>((acc, downbeat, index) => (downbeat ? [...acc, index + 1] : acc), []);
    expect(downbeats).toEqual([1, 5]);
  });
});
