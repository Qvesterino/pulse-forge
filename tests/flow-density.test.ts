import { describe, expect, it } from "vitest";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { generateMultiVoice } from "../src/intent/multi-voice";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { STEP_TICKS } from "../src/project-model/types";

/**
 * FLOW DENSITY (roadmap engine idea) — the rap-flow grid on the lead line:
 * "triplet flow" snaps lead starts to the 80-tick triplet-16th grid (the
 * trap/detroit bounce), "offbeat flow" pushes them half a 16th late. Bass
 * and chords keep the straight grid — the groove anchors, the flow rides.
 */

const doc = () => createProjectFromTemplate("house");

function leadStarts(flow: "triplet" | "offbeat" | undefined): number[] {
  const result = generateMultiVoice(doc(), "trap", 12345, 32, null, 0.7, 0.3, 0.5, 0.5, undefined, flow);
  return result.lead.map((n) => n.start);
}

describe("flow density — the rap-flow grid", () => {
  it("parser: triplet / offbeat flow phrases set IntentSpec.flow", () => {
    expect(normalizeIntent(parseIntentText("triplet flow type beat").input).flow).toBe("triplet");
    expect(normalizeIntent(parseIntentText("tripletovy flow drill").input).flow).toBe("triplet");
    expect(normalizeIntent(parseIntentText("offbeat flow at 140").input).flow).toBe("offbeat");
    // Bare "triplet" without flow context stays clear of the field.
    expect(normalizeIntent(parseIntentText("dark trap at 140").input).flow).toBeUndefined();
  });

  it("triplet flow snaps every lead start to the 80-tick grid", () => {
    const starts = leadStarts("triplet");
    expect(starts.length).toBeGreaterThan(0);
    const grid = STEP_TICKS * (2 / 3); // 80 ticks — triplet 16ths
    for (const start of starts) {
      expect(Math.abs(start - Math.round(start / grid) * grid)).toBeLessThan(0.01);
    }
    // And it actually MOVED notes off the straight 16th grid (that's the point).
    const straight = leadStarts(undefined);
    expect(starts).not.toEqual(straight);
  });

  it("offbeat flow pushes lead starts half a 16th late", () => {
    for (const start of leadStarts("offbeat")) {
      expect((((start - STEP_TICKS / 2) % STEP_TICKS) + STEP_TICKS) % STEP_TICKS).toBeCloseTo(0, 3);
    }
  });

  it("no flow → straight grid unchanged (bass never moves)", () => {
    const result = generateMultiVoice(doc(), "trap", 12345, 32, null, 0.7, 0.3, 0.5, 0.5, undefined, undefined);
    for (const note of result.bass) {
      expect(note.start % STEP_TICKS).toBe(0);
    }
  });
});
