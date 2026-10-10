import { describe, it, expect } from "vitest";
import { applyTransitionToPattern, transitionTreatmentOf } from "../src/intent/transitions";
import { testDoc } from "./fixtures/doc";
import { inferPadRole } from "../src/ai/pad-roles";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

/**
 * FILL VOCABULARY (2026-10-10) — one hardcoded roll shape meant every fill
 * in every song read identically and the boundary's intensity was ignored.
 * The fill is now a SEEDED pick from a recipe pool (deterministic per
 * boundary — same boundary, same fill; different boundaries vary), gated by
 * the INCOMING section's intensity: a bridge turnaround reads subtle, a
 * drop lands the big one. Dropout (the silent gap) and the allowDrums
 * suppression are untouched.
 */

function drumPattern(stepCount = 64): Pattern {
  return {
    id: `pat-fill-${stepCount}`,
    name: "Fill Fixture",
    stepCount,
    rows: {},
    notes: {},
  };
}

function hitCount(pattern: Pattern, padId: string): number {
  return (pattern.rows[padId] ?? []).filter((v) => v > 0).length;
}

/** A doc with one drum track whose pads carry role-shaped NAMES (the role
 * resolver matches names first — "Snare" etc. resolve regardless of index). */
function fillDoc(): ProjectDocument {
  return testDoc();
}

/** The fixture kit's real pad ids by role (never invent ids — the paint
 * writes into the doc's own pad rows). */
function kitIds(doc: ProjectDocument): { kick: string[]; snare: string[]; all: string[] } {
  const kick: string[] = [];
  const snare: string[] = [];
  const all: string[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "drum") continue;
    for (const [index, pad] of track.pads.entries()) {
      const role = inferPadRole(pad.name, index);
      all.push(pad.id);
      if (role === "kick") kick.push(pad.id);
      if (role === "snare" || role === "clap") snare.push(pad.id);
    }
  }
  return { kick, snare, all };
}

describe("fill vocabulary", () => {
  it("the fill treatment paints the last bar and keeps the kick anchor", () => {
    const doc = fillDoc();
    const kit = kitIds(doc);
    const next = applyTransitionToPattern(doc, drumPattern(), "fill", { fillSeed: "seed-a", intensity: 0.9 });
    // SOMETHING plays in the last bar of the pattern, and the downbeat
    // kick anchor survives.
    const lastBarHits = Object.values(next.rows).reduce(
      (sum, row) => sum + row.slice(48, 64).filter((v) => v > 0).length,
      0,
    );
    expect(lastBarHits, "the fill lives in the outgoing last bar").toBeGreaterThan(0);
    const anchor = kit.kick.some((id) => (next.rows[id]?.[48] ?? 0) >= 0.85);
    expect(anchor, "the downbeat kick anchor survives the zeroed bar").toBe(true);
    // The roll voice actually plays (hits land on snare/clap pads).
    const rollHits = kit.snare.reduce((sum, id) => sum + hitCount(next, id), 0);
    expect(rollHits, "the roll voices play the fill").toBeGreaterThan(0);
  });

  it("same boundary key → same fill; different keys → varied recipes", () => {
    const doc = fillDoc();
    const a1 = applyTransitionToPattern(doc, drumPattern(), "fill", { fillSeed: "boundary-1", intensity: 0.9 });
    const a2 = applyTransitionToPattern(doc, drumPattern(), "fill", { fillSeed: "boundary-1", intensity: 0.9 });
    expect(JSON.stringify(a1.rows)).toBe(JSON.stringify(a2.rows));
    // Across many boundaries at least two distinct fill shapes appear (the
    // vocabulary is actually a vocabulary, not one shape with another name).
    const shapes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const filled = applyTransitionToPattern(doc, drumPattern(), "fill", {
        fillSeed: `boundary-var-${i}`,
        intensity: 0.9,
      });
      shapes.add(JSON.stringify(filled.rows));
    }
    expect(shapes.size, "the recipe pool produces more than one shape").toBeGreaterThanOrEqual(2);
  });

  it("intensity gates the tier — subtle boundaries never paint a full-bar roll", () => {
    const doc = fillDoc();
    // The subtle pool (half-push / ghost-turnaround / stop-tail) paints
    // restrained shapes: at most ~10 hits in the fill bar and no full-16
    // crescendo. The BIG tier (crescendo-roll / kick-drive) paints 16+.
    for (let i = 0; i < 8; i++) {
      const subtle = applyTransitionToPattern(doc, drumPattern(), "fill", {
        fillSeed: `subtle-${i}`,
        intensity: 0.4,
      });
      const lastBarHits = Object.values(subtle.rows).reduce(
        (sum, row) => sum + row.slice(48, 64).filter((v) => v > 0).length,
        0,
      );
      expect(lastBarHits, `subtle boundary ${i} stays restrained`).toBeLessThanOrEqual(14);
      // The crescendo signature — a single roll row covering all 16 steps —
      // never appears at subtle intensity.
      for (const row of Object.values(subtle.rows)) {
        expect(row.slice(48, 64).filter((v) => v > 0).length, "no full-bar roll at subtle").toBeLessThan(16);
      }
    }
    // And the big tier DOES paint the full-bar signature for at least some
    // high-intensity boundaries (the pool actually serves both tiers).
    const bigShapes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const big = applyTransitionToPattern(doc, drumPattern(), "fill", {
        fillSeed: `big-${i}`,
        intensity: 0.9,
      });
      bigShapes.push(
        Object.values(big.rows).reduce((sum, row) => sum + row.slice(48, 64).filter((v) => v > 0).length, 0),
      );
    }
    expect(Math.max(...bigShapes), "big boundaries reach the full-bar roll").toBeGreaterThanOrEqual(16);
  });

  it("dropout stays pure removal and unknown types return the pattern unchanged", () => {
    const doc = fillDoc();
    const pattern = drumPattern();
    pattern.rows["snare-pad"] = new Array(64).fill(0).map((_, i) => (i % 4 === 0 ? 0.8 : 0));
    const dropped = applyTransitionToPattern(doc, pattern, "break", {});
    expect(dropped.rows["snare-pad"].slice(48, 64).every((v) => v === 0)).toBe(true);
    expect(dropped.rows["snare-pad"].slice(0, 48).some((v) => v > 0)).toBe(true);
    expect(transitionTreatmentOf("impact")).toBeNull();
    expect(applyTransitionToPattern(doc, pattern, "impact")).toBe(pattern);
  });

  it("allowDrums: false suppresses drum treatments (the user's role request cuts across)", () => {
    const doc = fillDoc();
    const pattern = drumPattern();
    const untouched = applyTransitionToPattern(doc, pattern, "fill", { allowDrums: false });
    expect(untouched).toBe(pattern);
  });
});
