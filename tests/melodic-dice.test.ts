/**
 * Melodic dice — seeded scale-aware phrase generator.
 * Determinism is the contract: preview and apply must produce identical notes.
 */
import { describe, expect, it } from "vitest";
import { buildMelodicPhrase } from "../src/ai/melodicDice";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { getScalePitchesInRange } from "../src/project-model/scales";
import { STEP_TICKS } from "../src/project-model/types";

const doc = createProjectFromTemplate("house");
const KEY = doc.key ?? ("A Natural Minor" as const);

describe("buildMelodicPhrase", () => {
  it("is deterministic per seed and options", () => {
    const opts = { seed: "abc123", lengthSteps: 32, density: 0.5, energy: 0.5, key: KEY };
    const a = buildMelodicPhrase(doc, opts);
    const b = buildMelodicPhrase(doc, opts);
    // ids are unique per call — compare the musical content
    const strip = (ns: typeof a.notes) => ns.map(({ id: _id, ...rest }) => rest);
    expect(strip(a.notes)).toEqual(strip(b.notes));
  });

  it("keeps every note on the project scale", () => {
    const phrase = buildMelodicPhrase(doc, {
      seed: "scale-check",
      lengthSteps: 64,
      density: 0.8,
      energy: 0.9,
      key: KEY,
    });
    const scale = getScalePitchesInRange(KEY, 0, 127);
    expect(phrase.notes.length).toBeGreaterThan(0);
    for (const note of phrase.notes) {
      expect(scale.has(note.pitch)).toBe(true);
      expect(note.velocity).toBeGreaterThan(0);
      expect(note.duration).toBeGreaterThanOrEqual(STEP_TICKS);
    }
  });

  it("respects the phrase length and clamps notes inside it", () => {
    const lengthSteps = 16;
    const phrase = buildMelodicPhrase(doc, {
      seed: "len",
      lengthSteps,
      density: 0.9,
      energy: 0.3,
      key: KEY,
    });
    for (const note of phrase.notes) {
      expect(note.start).toBeGreaterThanOrEqual(0);
      expect(note.start).toBeLessThan(lengthSteps * STEP_TICKS);
      expect(note.start + note.duration).toBeLessThanOrEqual(lengthSteps * STEP_TICKS);
    }
  });

  it("different seeds produce different phrases", () => {
    const a = buildMelodicPhrase(doc, { seed: "one", lengthSteps: 32, density: 0.6, energy: 0.5, key: KEY });
    const b = buildMelodicPhrase(doc, { seed: "two", lengthSteps: 32, density: 0.6, energy: 0.5, key: KEY });
    expect(a.notes).not.toEqual(b.notes);
  });
});
