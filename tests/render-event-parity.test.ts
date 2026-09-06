import { unfreezeDoc } from "../src/rendering/renderer";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { describe, expect, it } from "vitest";
import { generatePattern } from "../src/ai/generator";
import { patternEventsInWindow } from "../src/project-model/events";
import { createDefaultProject } from "../src/project-model/schema";
import { STEP_TICKS } from "../src/project-model/types";
import { AI_BASELINE_CASES, baselineOptions } from "./fixtures/ai-baseline";

function drumKey(hit: {
  trackId: string;
  pad: { id: string };
  tick: number;
  velocity: number;
  ratchetIndex: number;
}): string {
  return [hit.trackId, hit.pad.id, hit.tick.toFixed(6), hit.velocity.toFixed(6), hit.ratchetIndex].join("|");
}

function noteKey(event: {
  trackId: string;
  tick: number;
  note: { pitch: number; duration: number; velocity: number };
}): string {
  return [event.trackId, event.tick, event.note.pitch, event.note.duration, event.note.velocity].join("|");
}

describe("realtime/offline event plan parity", () => {
  it("preserves the same absolute drum and melodic events when a window is split", () => {
    const doc = createDefaultProject();
    const pattern = generatePattern(doc, baselineOptions(AI_BASELINE_CASES[0], 32));
    const total = pattern.stepCount * STEP_TICKS;
    const full = patternEventsInWindow(doc, pattern, 0, 0, total);
    const boundaries = [0, 300, 720, 1199, total];
    const splitPlans = boundaries
      .slice(0, -1)
      .map((from, index) => patternEventsInWindow(doc, pattern, 0, from, boundaries[index + 1]));
    const fullDrums = full.drums.map(drumKey).sort();
    const splitDrums = splitPlans
      .flatMap((plan) => plan.drums)
      .map(drumKey)
      .sort();
    const fullNotes = full.notes.map(noteKey).sort();
    const splitNotes = splitPlans
      .flatMap((plan) => plan.notes)
      .map(noteKey)
      .sort();
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

describe("render parity — frozen tracks (offline export audit)", () => {
  it("unfreezeDoc strips frozen state and leaves other tracks untouched", () => {
    const doc = createProjectFromTemplate("house") as unknown as Record<string, unknown>;
    const drum = (doc.tracks as Record<string, unknown>[]).find((t) => t.kind === "drum")!;
    const inst = (doc.tracks as Record<string, unknown>[]).find((t) => t.kind === "instrument")!;
    drum.frozen = { bufferId: "buf-d", durationSec: 4, sampleRate: 44100 };
    inst.frozen = { bufferId: "buf-i", durationSec: 4, sampleRate: 44100 };

    const out = unfreezeDoc(doc as never) as unknown as Record<string, unknown>;
    for (const t of out.tracks as Record<string, unknown>[]) {
      expect("frozen" in t).toBe(false);
    }
    expect((out.tracks as unknown[]).length).toBe((doc.tracks as unknown[]).length);
    // Non-frozen fields intact.
    expect(((out.tracks as Record<string, unknown>[])[0] as Record<string, unknown>).id).toBe(
      (doc.tracks as Record<string, unknown>[])[0].id,
    );
    // Idempotent + no-op fast path when nothing is frozen.
    expect(unfreezeDoc(out as never)).toBe(out);
    const clean = createProjectFromTemplate("house");
    expect(unfreezeDoc(clean)).toBe(clean);
  });
});
