import { describe, expect, it } from "vitest";
import { generatePattern } from "../src/ai/generator";
import { patternEventsInWindow } from "../src/project-model/events";
import { createDefaultProject } from "../src/project-model/schema";
import { STEP_TICKS } from "../src/project-model/types";
import { AI_BASELINE_CASES, baselineOptions } from "./fixtures/ai-baseline";

function drumKey(hit: { trackId: string; pad: { id: string }; tick: number; velocity: number; ratchetIndex: number }): string {
  return [hit.trackId, hit.pad.id, hit.tick.toFixed(6), hit.velocity.toFixed(6), hit.ratchetIndex].join("|");
}

function noteKey(event: { trackId: string; tick: number; note: { pitch: number; duration: number; velocity: number } }): string {
  return [event.trackId, event.tick, event.note.pitch, event.note.duration, event.note.velocity].join("|");
}

describe("realtime/offline event plan parity", () => {
  it("preserves the same absolute drum and melodic events when a window is split", () => {
    const doc = createDefaultProject();
    const pattern = generatePattern(doc, baselineOptions(AI_BASELINE_CASES[0], 32));
    const total = pattern.stepCount * STEP_TICKS;
    const full = patternEventsInWindow(doc, pattern, 0, 0, total);
    const boundaries = [0, 300, 720, 1199, total];
    const splitPlans = boundaries.slice(0, -1).map((from, index) =>
      patternEventsInWindow(doc, pattern, 0, from, boundaries[index + 1]),
    );
    const fullDrums = full.drums.map(drumKey).sort();
    const splitDrums = splitPlans.flatMap((plan) => plan.drums).map(drumKey).sort();
    const fullNotes = full.notes.map(noteKey).sort();
    const splitNotes = splitPlans.flatMap((plan) => plan.notes).map(noteKey).sort();
    expect(splitDrums).toEqual(fullDrums);
    expect(splitNotes).toEqual(fullNotes);
  });

  it("loops note events at the same pattern-relative positions as playback", () => {
    const doc = createDefaultProject();
    const pattern = generatePattern(doc, baselineOptions(AI_BASELINE_CASES[0], 16));
    const first = patternEventsInWindow(doc, pattern, 0, 0, 16 * STEP_TICKS).notes;
    const looped = patternEventsInWindow(doc, pattern, 0, 16 * STEP_TICKS, 32 * STEP_TICKS).notes;
    expect(looped.map((event) => event.tick - 16 * STEP_TICKS)).toEqual(first.map((event) => event.tick));
  });
});
