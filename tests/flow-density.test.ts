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

  it("triplet flow GENERATES on the 80-tick grid (not a post-snap)", () => {
    const starts = leadStarts("triplet");
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      expect(start % 80).toBe(0); // exact triplet-16th positions
    }
    // Regeneration proof: at least one note sits BETWEEN straight 16ths —
    // a position the old post-snap of a straight motif could produce only
    // by luck, and the triplet pattern table produces by design.
    expect(starts.some((start) => start % STEP_TICKS !== 0)).toBe(true);
    // Motif replay integrity: with a 5-bar phrase the bar-4 replay keeps
    // the same grid.
    const long = generateMultiVoice(doc(), "trap", 12345, 80, null, 0.7, 0.3, 0.5, 0.5, undefined, "triplet");
    for (const note of long.lead) expect(note.start % 80).toBe(0);
  });

  it("flow gating: no two lead notes overlap (monophonic rap flow)", () => {
    const result = generateMultiVoice(doc(), "trap", 12345, 64, null, 0.75, 0.3, 0.5, 0.5, undefined, "triplet");
    const sorted = [...result.lead].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(sorted[i]!.start + sorted[i]!.duration).toBeLessThanOrEqual(sorted[i + 1]!.start + 0.01);
    }
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

describe("artist flow defaults", () => {
  it("babytron carries the offbeat default; user triplet wins", () => {
    expect(normalizeIntent(parseIntentText("babytron type beat").input).flow).toBe("offbeat");
    expect(normalizeIntent(parseIntentText("triplet flow babytron").input).flow).toBe("triplet");
    expect(parseIntentText("babytron type beat").detected.some((d) => d.includes("offbeat flow"))).toBe(false);
  });

  it("snoop laid-back offbeat; grime straight", () => {
    expect(normalizeIntent(parseIntentText("snoop dogg type beat").input).flow).toBe("offbeat");
    expect(normalizeIntent(parseIntentText("skepta type beat").input).flow).toBe("straight");
  });
});
