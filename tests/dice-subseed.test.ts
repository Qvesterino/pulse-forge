import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { generatePattern } from "../src/ai/generator";
import { DEFAULT_GENERATE_OPTIONS } from "../src/ai/types";
import { getActivePattern, getDrumTrack } from "../src/project-model/types";

describe("dice subSeed locks", () => {
  it("locked kick stays identical (subSeed, no RNG advance)", () => {
    const doc = testDoc();
    const prev = getActivePattern(doc);
    // Use a deterministic seed where we know groove includes kick
    const opts = { ...DEFAULT_GENERATE_OPTIONS, seed: "house-seed-1", stepCount: 16, genre: "house" as const };
    const locked = generatePattern(doc, opts, { kick: true, prevPattern: prev });
    const drumTrack = getDrumTrack(doc);
    // Find kick pads that were present in prev and should be locked
    const kickPads = drumTrack.pads.filter((p) => p.name.toLowerCase().includes("kick"));
    // At least one kick should be locked and equal prev (if groove included it, it will be equal; if not, it may be undefined — check those that exist)
    let checked = 0;
    for (const pad of kickPads) {
      if (locked.rows[pad.id] && prev.rows[pad.id]) {
        expect(locked.rows[pad.id]).toEqual(prev.rows[pad.id]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("drums lock copies all rows", () => {
    const doc = testDoc();
    const prev = getActivePattern(doc);
    const opts = { ...DEFAULT_GENERATE_OPTIONS, seed: "abc", stepCount: 16, genre: "house" as const };
    const locked = generatePattern(doc, opts, { drums: true, prevPattern: prev });
    for (const padId of Object.keys(prev.rows)) {
      if (locked.rows[padId]) expect(locked.rows[padId]).toEqual(prev.rows[padId]);
    }
  });
});
