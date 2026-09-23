import { describe, expect, it } from "vitest";
import { testDoc } from "./fixtures/doc";
import { generatePattern } from "../src/ai/generator";
import { generateMelodicParts } from "../src/ai/melodic";
import { generateMultiVoice } from "../src/intent/multi-voice";
import { mulberry32 } from "../src/shared/rng";
import type { GenerateOptions } from "../src/ai/types";
import type { NoteEvent } from "../src/project-model/types";

/**
 * P2 MELODIC DYNAMICS — the intent sliders reach the melody, not just drums.
 *
 * Before P2, energy/density/complexity shaped only the drum layer
 * (velocityVariation/ghostWeight/microWeight/temperature); the template
 * melody read temperature alone and multi-voice read energy for a single
 * lead gate. A "more energetic bridge" revise on a melodic-only section was
 * a content no-op (INTENT_ENGINE.md §5.11).
 *
 * Invariant under test: every gain is identity at the intent defaults
 * (energy 0.7, density 0.5, complexity 0.5), so default renders stay
 * bit-identical to the golden baselines.
 */

function makeOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "house",
    seed: "melodic-dynamics",
    stepCount: 64,
    ghostWeight: 0.3,
    microWeight: 0.2,
    velocityVariation: 0.3,
    temperature: 1.0,
    replaceMode: "new",
    ...overrides,
  };
}

/** Note identity without unstable ids (uid() is not content). */
function sig(notes: NoteEvent[]): Array<[number, number, number, number]> {
  return notes.map((n) => [n.pitch, n.start, n.duration, n.velocity]);
}

function meanVelocity(notes: NoteEvent[]): number {
  if (notes.length === 0) return 0;
  return notes.reduce((sum, n) => sum + n.velocity, 0) / notes.length;
}

describe("P2 template melody dynamics (generateMelodicParts)", () => {
  it("default sliders render bit-identical melody (absent hints == neutral hints)", () => {
    const plain = generateMelodicParts(makeOptions(), mulberry32(7), "C Major");
    const neutral = generateMelodicParts(
      makeOptions({ _diceEnergy: 0.7, _diceDensity: 0.5 }),
      mulberry32(7),
      "C Major",
    );
    expect(sig(neutral.bass)).toEqual(sig(plain.bass));
    expect(sig(neutral.chord)).toEqual(sig(plain.chord));
    expect(sig(neutral.lead)).toEqual(sig(plain.lead));
  });

  it("energy scales melodic velocity deterministically", () => {
    const low = generateMelodicParts(makeOptions({ _diceEnergy: 0.3 }), mulberry32(7), "C Major");
    const high = generateMelodicParts(makeOptions({ _diceEnergy: 0.9 }), mulberry32(7), "C Major");
    const lowNotes = [...low.bass, ...low.chord, ...low.lead];
    const highNotes = [...high.bass, ...high.chord, ...high.lead];
    expect(lowNotes.length).toBeGreaterThan(0);
    expect(highNotes.length).toBe(lowNotes.length); // energy moves velocity, not count
    expect(meanVelocity(highNotes)).toBeGreaterThan(meanVelocity(lowNotes));
    // Same input twice → same output (seeded determinism preserved).
    const highAgain = generateMelodicParts(makeOptions({ _diceEnergy: 0.9 }), mulberry32(7), "C Major");
    expect(sig([...highAgain.bass, ...highAgain.chord, ...highAgain.lead])).toEqual(sig(highNotes));
  });

  it("density scales melodic note count (bass role)", () => {
    const sparse = generateMelodicParts(makeOptions({ _diceDensity: 0.2 }), mulberry32(7), "C Major");
    const dense = generateMelodicParts(makeOptions({ _diceDensity: 0.9 }), mulberry32(7), "C Major");
    expect(sparse.bass.length).toBeGreaterThan(0);
    expect(dense.bass.length).toBeGreaterThan(sparse.bass.length);
  });
});

describe("P2 multi-voice dynamics (generateMultiVoice)", () => {
  it("legacy 7-arg call equals explicit-default 9-arg call (golden parity)", () => {
    const doc = testDoc();
    const legacy = generateMultiVoice(doc, "house", 42, 64, "C Natural Minor", 0.8, 0.3);
    const explicit = generateMultiVoice(doc, "house", 42, 64, "C Natural Minor", 0.8, 0.3, 0.5, 0.5);
    expect(sig(explicit.bass)).toEqual(sig(legacy.bass));
    expect(sig(explicit.chord)).toEqual(sig(legacy.chord));
    expect(sig(explicit.lead)).toEqual(sig(legacy.lead));
  });

  it("lead rhythm thins with energy instead of only gating (0.5 sparse, 0.8 full, 0.3 none)", () => {
    const doc = testDoc();
    const low = generateMultiVoice(doc, "house", 42, 64, null, 0.3, 0.3);
    const mid = generateMultiVoice(doc, "house", 42, 64, null, 0.5, 0.3);
    const high = generateMultiVoice(doc, "house", 42, 64, null, 0.8, 0.3);
    expect(low.lead.length).toBe(0); // threshold preserved
    expect(mid.lead.length).toBeGreaterThan(0);
    expect(high.lead.length).toBeGreaterThan(mid.lead.length);
  });

  it("bass grows 16th pickups with density (0.9 > 0.5, deterministic)", () => {
    const doc = testDoc();
    const base = generateMultiVoice(doc, "house", 42, 64, "C Natural Minor", 0.8, 0.3);
    const dense = generateMultiVoice(doc, "house", 42, 64, "C Natural Minor", 0.8, 0.3, 0.9, 0.5);
    expect(dense.bass.length).toBeGreaterThan(base.bass.length);
    const denseAgain = generateMultiVoice(doc, "house", 42, 64, "C Natural Minor", 0.8, 0.3, 0.9, 0.5);
    expect(sig(denseAgain.bass)).toEqual(sig(dense.bass));
  });
});

describe("P2 end-to-end: energy revise changes melody, not just drums (§5.11 fix)", () => {
  it("same seed + raised energy hint → identical drums, different melodic content", () => {
    const doc = testDoc();
    const base = generatePattern(doc, { ...makeOptions(), seed: "revise-fix", stepCount: 32 });
    const revised = generatePattern(doc, {
      ...makeOptions(),
      seed: "revise-fix",
      stepCount: 32,
      _diceEnergy: 0.85,
    });
    // The hint alone never reaches the drum layer (energy shapes drums only
    // through velocityVariation/ghostWeight, which are unchanged here).
    expect(revised.rows).toEqual(base.rows);
    // …but the melody moves: new velocities → new content hash.
    const baseNotes = Object.values(base.notes).flat();
    const revisedNotes = Object.values(revised.notes).flat();
    expect(baseNotes.length).toBeGreaterThan(0);
    expect(sig(revisedNotes)).not.toEqual(sig(baseNotes));
    expect(revised.generation?.outputContentHash).not.toBe(base.generation?.outputContentHash);
  });
});
