import { describe, it, expect } from "vitest";
import { planVocalHarmony, planVocalHarmonyPair } from "../src/vocal/harmony";

/**
 * VOCAL HARMONY (YIN reuse) — diatonic harmony stacks over a sung melody.
 * The melody here is what YIN tracking + hum-to-notes produced; every
 * harmony note must stay INSIDE the key, at the requested diatonic
 * distance, folded into the singer's octave.
 */

const C_MAJOR = "C Major" as const;
const C_MINOR = "C Natural Minor" as const;

/** C major scale semitone set for pitch-class assertions. */
const C_MAJOR_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);
const C_MINOR_PITCH_CLASSES = new Set([0, 2, 3, 5, 7, 8, 10]);

describe("planVocalHarmony", () => {
  it("third-above stacks a diatonic third in C major", () => {
    // C(60) E(64) G(67) — the scale run
    const melody = [
      { pitch: 60, start: 0, duration: 480 },
      { pitch: 64, start: 480, duration: 480 },
      { pitch: 67, start: 960, duration: 480 },
    ];
    const harmony = planVocalHarmony(melody, C_MAJOR, "third-above");
    expect(harmony).toHaveLength(3);
    // C → E, E → G, G → B (all diatonic thirds)
    expect(harmony.map((n) => n.pitch)).toEqual([64, 67, 71]);
    for (const note of harmony) expect(note.interval).toBe("third-above");
  });

  it("third-below stacks below without crossing below the octave fold", () => {
    const melody = [{ pitch: 67, start: 0, duration: 480 }]; // G
    const harmony = planVocalHarmony(melody, C_MAJOR, "third-below");
    // G's diatonic third below is E (64) — same octave, no fold needed
    expect(harmony[0]!.pitch).toBe(64);
  });

  it("folds the harmony into the singer's octave (no drifting stacks)", () => {
    // E near the top of the octave: third-above wants G, fold keeps it close
    const melody = [{ pitch: 64, start: 0, duration: 480 }];
    const harmony = planVocalHarmony(melody, C_MAJOR, "third-above");
    expect(Math.abs(harmony[0]!.pitch - 64)).toBeLessThanOrEqual(12);
  });

  it("snaps off-scale melody notes before stacking (blues notes welcome)", () => {
    // F# (66) is off-scale in C major — the stack still lands on scale tones
    const melody = [{ pitch: 66, start: 0, duration: 480 }];
    const harmony = planVocalHarmony(melody, C_MAJOR, "third-above");
    expect(C_MAJOR_PITCH_CLASSES.has(((harmony[0]!.pitch % 12) + 12) % 12)).toBe(true);
    expect(harmony[0]!.pitch).not.toBe(66); // never a unison with the sung note
  });

  it("stays key-safe in minor", () => {
    // A natural minor melody: A C E (57, 60, 64)
    const melody = [
      { pitch: 57, start: 0, duration: 480 },
      { pitch: 60, start: 480, duration: 480 },
      { pitch: 64, start: 960, duration: 480 },
    ];
    const harmony = planVocalHarmony(melody, C_MINOR, "third-above");
    for (const note of harmony) {
      expect(C_MINOR_PITCH_CLASSES.has(((note.pitch % 12) + 12) % 12)).toBe(true);
    }
  });

  it("returns empty for an unparseable key and for empty melodies", () => {
    expect(planVocalHarmony([{ pitch: 60, start: 0, duration: 1 }], "Nonsense Key" as never)).toEqual([]);
    expect(planVocalHarmony([], C_MAJOR)).toEqual([]);
  });

  it("pair provides the classic above+below backing stack", () => {
    const pair = planVocalHarmonyPair([{ pitch: 60, start: 0, duration: 480 }], C_MAJOR);
    expect(pair.above[0]!.pitch).toBe(64); // E above
    expect(pair.below[0]!.pitch).toBe(57); // A below (diatonic third under C)
    expect(pair.above[0]!.pitch).not.toBe(pair.below[0]!.pitch);
  });
});
