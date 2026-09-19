import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { applyTransitionToPattern, transitionTreatmentOf } from "../src/intent/transitions";
import { buildSong } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { generatePattern } from "../src/ai/generator";
import { inferPadRole } from "../src/ai/pad-roles";
import { buildPhrasePlan } from "../src/ai/phrase";
import { DEFAULT_GENERATE_OPTIONS } from "../src/ai/types";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

const doc = testDoc();
const drumTrack = doc.tracks.find((t) => t.kind === "drum")!;
const pads = drumTrack.kind === "drum" ? drumTrack.pads : [];
const padByRole = (role: string) => pads.filter((pad, index) => inferPadRole(pad.name, index) === role).map((pad) => pad.id);

function makePattern(stepCount: number): Pattern {
  const rows: Record<string, number[]> = {};
  // light kick/snare groove so treatments have something to modify
  for (const padId of padByRole("kick")) {
    rows[padId] = Array.from({ length: stepCount }, (_, step) => (step % 8 === 0 ? 0.9 : 0));
  }
  for (const padId of padByRole("snare")) {
    rows[padId] = Array.from({ length: stepCount }, (_, step) => (step % 8 === 4 ? 0.7 : 0));
  }
  return {
    id: "pattern-test",
    name: "test",
    stepCount,
    rows,
    notes: {},
    phrasePlan: buildPhrasePlan(stepCount),
  };
}

const barHits = (pattern: Pattern, bar: number) => {
  let count = 0;
  const velocities: number[] = [];
  for (const row of Object.values(pattern.rows)) {
    for (let step = bar * 16; step < (bar + 1) * 16 && step < row.length; step++) {
      if (row[step] > 0) {
        count += 1;
        velocities.push(row[step]);
      }
    }
  }
  return { count, velocities };
};

describe("transition treatments (T3)", () => {
  it("maps transition types to treatments", () => {
    expect(transitionTreatmentOf("fill")).toBe("fill");
    expect(transitionTreatmentOf("riser")).toBe("riser");
    expect(transitionTreatmentOf("break")).toBe("dropout");
    expect(transitionTreatmentOf("drop")).toBeNull();
    expect(transitionTreatmentOf("impact")).toBeNull();
  });

  it("fill: full-bar crescendo roll in the LAST bar only", () => {
    const pattern = makePattern(64);
    const before = barHits(pattern, 0);
    const filled = applyTransitionToPattern(doc, pattern, "fill");
    const last = barHits(filled, 3);
    // a real roll: dense (≥12 hits) and crescendo (last louder than first)
    expect(last.count).toBeGreaterThanOrEqual(12);
    const sorted = [...last.velocities].sort((a, b) => a - b);
    expect(sorted[0]).toBeLessThan(sorted[sorted.length - 1]);
    // kick anchor preserved on the fill downbeat
    const kickId = padByRole("kick")[0];
    expect(filled.rows[kickId]![48]).toBe(0.9);
    // earlier bars untouched
    expect(barHits(filled, 0)).toEqual(before);
  });

  it("riser: two-bar build (pulse bar + roll bar)", () => {
    const pattern = makePattern(64);
    const filled = applyTransitionToPattern(doc, pattern, "riser");
    const pulseBar = barHits(filled, 2);
    const rollBar = barHits(filled, 3);
    expect(pulseBar.count).toBeGreaterThanOrEqual(4); // quarter pulse
    expect(rollBar.count).toBeGreaterThanOrEqual(12); // full 16th roll
    expect(rollBar.velocities.length).toBeGreaterThan(0);
    // crescendo across the roll
    const sorted = [...rollBar.velocities].sort((a, b) => a - b);
    expect(sorted[0]).toBeLessThan(sorted[sorted.length - 1]);
    // first two bars untouched
    expect(barHits(filled, 0)).toEqual(barHits(pattern, 0));
    expect(barHits(filled, 1)).toEqual(barHits(pattern, 1));
  });

  it("break: dropout — the outgoing last bar goes silent", () => {
    const pattern = makePattern(64);
    const dropped = applyTransitionToPattern(doc, pattern, "break");
    expect(barHits(dropped, 3).count).toBe(0);
    expect(barHits(dropped, 2).count).toBeGreaterThan(0);
    expect(barHits(dropped, 0)).toEqual(barHits(pattern, 0));
  });

  it("non-sounding types return the pattern unchanged", () => {
    const pattern = makePattern(16);
    expect(applyTransitionToPattern(doc, pattern, "drop")).toBe(pattern);
    expect(applyTransitionToPattern(doc, pattern, "impact")).toBe(pattern);
  });

  it("is deterministic", () => {
    const pattern = makePattern(64);
    const first = applyTransitionToPattern(doc, pattern, "fill");
    const second = applyTransitionToPattern(doc, pattern, "fill");
    expect(first.rows).toEqual(second.rows);
  });

  it("works on generated patterns with real kits", () => {
    const options = { ...DEFAULT_GENERATE_OPTIONS, genre: "house" as const, seed: "t3", stepCount: 64 };
    const generated = generatePattern(doc, options);
    const filled = applyTransitionToPattern(doc, generated, "fill");
    expect(barHits(filled, 3).count).toBeGreaterThanOrEqual(12);
    expect(barHits(filled, 0).count).toBeGreaterThan(0);
  });
});

describe("song builder transition baking (T3)", () => {
  it("outgoing sections carry the baked transition sound", async () => {
    const buildDoc: ProjectDocument = testDoc();
    const build = await buildSong(buildDoc, normalizeIntent({ genre: "house", seed: "t3-song" }), {
      yieldBetweenSections: false,
    });
    const byLabel = Object.fromEntries(build.sections.map((section) => [section.label, section]));
    const lastBarOf = (section: (typeof build.sections)[number]) => section.stepCount / 16 - 1;
    const barCountOf = (section: (typeof build.sections)[number], bar: number) => barHits(section.pattern, bar);
    // Build A →riser into Drop A: its last TWO bars are the riser
    const buildA = byLabel["Build A"];
    expect(barCountOf(buildA, lastBarOf(buildA) - 1).count).toBeGreaterThanOrEqual(4);
    expect(barCountOf(buildA, lastBarOf(buildA)).count).toBeGreaterThanOrEqual(12);
    // Drop A →dropout into Break: its last bar is SILENT
    const dropA = byLabel["Drop A"];
    expect(barCountOf(dropA, lastBarOf(dropA)).count).toBe(0);
    // Break (drum-free instrumentation [chords,lead]) →fill into Build B:
    // the drum-based fill is SUPPRESSED — "no drums" cuts across transitions
    const breakPat = byLabel["Break"];
    expect(barCountOf(breakPat, lastBarOf(breakPat)).count).toBe(0);
  }, 60_000);
});
