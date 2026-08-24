import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { generatePattern } from "../src/ai/generator";
import { generateDrumPattern } from "../src/ai/drums";
import {
  buildPadModel,
  decodePosition,
  encodeState,
  generatePadSequence,
  sampleTransition,
} from "../src/ai/markov";
import { decodeMelodicState, encodeMelodicState } from "../src/ai/melodic";
import { contentHash, canonicalizePattern } from "../src/ai/evaluation";
import { forkRandom, mulberry32 } from "../src/shared/rng";
import { getGrooveById } from "../src/ai/grooves/index";
import { canRatchet, inferPadRole } from "../src/ai/pad-roles";
import { buildPhrasePlan } from "../src/ai/phrase";
import { enforceDrumAnchors, measureDrumQuality, measureMelodicQuality } from "../src/ai/quality";
import { enforceSyncopationBudget, evaluateStyleDistance, getStyleQualityProfile, syncopationWeight } from "../src/ai/style-quality";
import type { GenerateOptions } from "../src/ai/types";

function makeOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "house",
    seed: "correctness-test",
    stepCount: 16,
    ghostWeight: 0,
    microWeight: 0,
    velocityVariation: 0,
    temperature: 1,
    replaceMode: "new",
    ...overrides,
  };
}

describe("correctness-1 deterministic foundation", () => {
  it("keeps melodic state encoding round-trippable, including rest and degree 6", () => {
    for (const degree of [-1, 0, 1, 6]) {
      for (const duration of [1, 2, 4, 8]) {
        const state = encodeMelodicState(degree, duration);
        expect(decodeMelodicState(state)).toEqual({ degree, duration });
      }
    }
  });

  it("samples only observed drum transitions and advances one bar position", () => {
    const model = buildPadModel(0, [[0.9, 0, 0.9, 0, 0.9, 0, 0.9, 0, 0.9, 0, 0.9, 0, 0.9, 0, 0.9, 0]]);
    let state = encodeState(3, 0, 1);

    for (let expectedPosition = 2; expectedPosition < 16; expectedPosition++) {
      state = sampleTransition(model, state, () => 0.999999, 1);
      expect(decodePosition(state)).toBe(expectedPosition);
    }

    expect(generatePadSequence(model, 16, () => 0.999999)).toEqual(
      [3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0],
    );
  });

  it("keeps independent random streams stable when another subsystem consumes randomness", () => {
    const first = forkRandom("seed", "melody");
    const expected = [first(), first(), first()];

    const second = forkRandom("seed", "melody");
    const unrelated = forkRandom("seed", "drums");
    unrelated();
    unrelated();
    expect([second(), second(), second()]).toEqual(expected);
  });

  it("records UUID-free input/output provenance on generated patterns", () => {
    const doc = createDefaultProject();
    const options = makeOptions({ seed: "provenance" });
    const first = generatePattern(doc, options);
    const second = generatePattern(doc, options);

    expect(first.generation).toMatchObject({
      engineId: "pulse-forge.local-groove",
      engineVersion: "correctness-1",
      seed: "provenance",
      grooveId: expect.any(String),
      inputContentHash: null,
    });
    expect(first.generation?.outputContentHash).toBe(contentHash(canonicalizePattern(doc, first)));
    expect(first.generation).toEqual(second.generation);
    expect(contentHash(canonicalizePattern(doc, first))).toBe(contentHash(canonicalizePattern(doc, second)));
  });

  it("does not bake swing into pattern metadata when project groove owns it", () => {
    const groove = getGrooveById("house.minimal")!;
    const options = makeOptions({ applyGrooveSettings: true });
    const { meta } = generateDrumPattern(groove, options, mulberry32(42));

    for (const padMeta of meta.values()) {
      for (const entry of padMeta.values()) {
        expect(entry.microtiming).toBeUndefined();
      }
    }
  });

  it("does not add local swing when an existing project groove already owns timing", () => {
    const doc = createDefaultProject();
    doc.groove = { ...doc.groove, swing: 0.3 };
    const pattern = generatePattern(doc, makeOptions({ applyGrooveSettings: false }));

    for (const padMeta of Object.values(pattern.stepMeta ?? {})) {
      for (const entry of Object.values(padMeta)) {
        expect(entry.microtiming).toBeUndefined();
      }
    }
  });

  it("uses semantic pad roles instead of relying on the legacy pad order", () => {
    expect(inferPadRole("My Closed Hat", 0)).toBe("closedHat");
    expect(inferPadRole("Sub Kick", 12)).toBe("kick");
    expect(inferPadRole("Lead Clap", 1)).toBe("clap");
    expect(canRatchet(inferPadRole("Perc Shaker", 0))).toBe(true);
  });

  it("creates distinct multi-bar phrase sections", () => {
    expect(buildPhrasePlan(16).map(section => section.section)).toEqual(["main"]);
    expect(buildPhrasePlan(64).map(section => section.section)).toEqual([
      "main", "variation", "drop", "outro",
    ]);
    expect(buildPhrasePlan(80).map(section => section.section)).toEqual([
      "main", "variation", "drop", "fill", "outro",
    ]);
  });

  it("repairs hard kick and backbeat anchors deterministically", () => {
    const kick = new Array(16).fill(0);
    enforceDrumAnchors(kick, [[0.9, 0, 0, 0, 0.8, 0, 0, 0, 0.7, 0, 0, 0, 0.8, 0, 0, 0]], "kick");
    expect([kick[0], kick[4], kick[8], kick[12]].every(value => value > 0)).toBe(true);

    const groove = getGrooveById("house.driving")!;
    const quality = measureDrumQuality(groove, [kick], ["kick"], 16);
    expect(quality.anchorCoverage).toBe(1);
    expect(quality.velocityContrast).toBeGreaterThan(0);
  });

  it("measures melodic density, rests, durations, and motif novelty", () => {
    const quality = measureMelodicQuality([
      { id: "a", pitch: 60, start: 0, duration: 120, velocity: 0.8 },
      { id: "b", pitch: 62, start: 120, duration: 120, velocity: 0.7 },
    ], 16, "C Major");
    expect(quality.noteDensity).toBe(0.125);
    expect(quality.scaleValidity).toBe(1);
    expect(quality.pitchRange).toBe(2);
    expect(quality.occupiedStepRatio).toBe(0.125);
    expect(quality.restRatio).toBe(0.875);
    expect(quality.durationDistribution).toEqual({ short: 1, medium: 0, long: 0 });
    expect(quality.motifRepetition).toBe(0);
    expect(quality.motifNovelty).toBe(1);
  });

  it("keeps generated rows inside the genre style envelope", () => {
    const groove = getGrooveById("house.driving")!;
    const rows = groove.activePads.map(pad => groove.patterns[0][pad] ?? new Array(16).fill(0));
    const gate = evaluateStyleDistance(groove, rows, 16);
    expect(gate.accepted).toBe(true);
    expect(gate.distance).toBeLessThanOrEqual(getStyleQualityProfile("house").maxDistance);
    expect(getStyleQualityProfile("house", "Minimal").densityRange[1]).toBeLessThan(
      getStyleQualityProfile("house", "Driving").densityRange[1],
    );
  });

  it("repairs excessive syncopation deterministically by role", () => {
    const references = [new Array(16).fill(0).map((_, step) => step % 2 === 1 ? 0.9 : 0)];
    const first = new Array(16).fill(0.8);
    const second = [...first];
    enforceSyncopationBudget(first, references, "kick");
    enforceSyncopationBudget(second, references, "kick");
    expect(first).toEqual(second);
    expect(first[0]).toBeGreaterThan(0);
    expect(first.filter(value => value > 0).length).toBeLessThan(16);
    expect(syncopationWeight(0)).toBe(0);
    expect(syncopationWeight(1)).toBe(1);
  });
});
