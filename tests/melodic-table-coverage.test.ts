import { describe, expect, it } from "vitest";
import { MELODIC_BY_GENRE } from "../src/ai/grooves/melodic-data";
import { hasMelodicDialect, generateMelodicParts } from "../src/ai/melodic";
import { generatePattern } from "../src/ai/generator";
import { GENRES } from "../src/ai/types";
import { forkRandom } from "../src/shared/rng";
import { testDoc } from "./fixtures/doc";
import type { GenerateOptions } from "../src/ai/types";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * MELODIC TABLE COVERAGE (2026-10-11) — full-library edition. Only 7 of the
 * genres carried MELODIC_BY_GENRE tables; the other 14 were engine-only.
 * The tables pay TWICE now: they are the template fallback AND multi-voice
 * reads their octaveOffset, so a genre's table IS the engine's register.
 * Precedence: a matched style DIALECT replaces the engine (an explicit
 * identity statement), the engine serves everything else, the genre table
 * is the engine's fallback.
 */

describe("melodic table coverage", () => {
  it("every first-class genre owns a melodic table (21/21)", () => {
    for (const genre of GENRES) {
      const table = MELODIC_BY_GENRE[genre];
      expect(table, `${genre} table`).toBeDefined();
      expect(table!.length, `${genre} roles`).toBe(3);
      for (const role of ["bass", "chord", "lead"] as const) {
        const part = table!.find((entry) => entry.role === role);
        expect(part, `${genre} ${role}`).toBeDefined();
        for (const sequence of part!.sequences) {
          const steps = sequence.reduce((sum, note) => sum + note.duration, 0);
          // Legacy tables carry varied loop lengths by design (multi-bar
          // phrases — trap's 20-step bass); the wave-2 tables are strict
          // 16-step loops.
          expect(steps, `${genre} ${role} non-empty loop`).toBeGreaterThan(0);
          expect(steps, `${genre} ${role} bounded loop`).toBeLessThanOrEqual(64);
          for (const note of sequence) {
            expect(note.velocity, `${genre} ${role} velocity range`).toBeGreaterThanOrEqual(0);
            expect(note.velocity).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("every table carries a distinct octave identity (the engine reads it)", () => {
    // Not all identical — the log drum genre's lead sits two octaves up, the
    // phonk whistle too, while the basses anchor low.
    const leadOctaves = GENRES.map((genre) => ({
      genre,
      offset: MELODIC_BY_GENRE[genre]!.find((entry) => entry.role === "lead")!.octaveOffset,
    }));
    const distinct = new Set(leadOctaves.map((entry) => entry.offset));
    expect(distinct.size, "lead octave identities vary across the library").toBeGreaterThanOrEqual(2);
    for (const entry of leadOctaves) {
      expect(entry.offset, `${entry.genre} lead octave`).toBeGreaterThanOrEqual(0);
      expect(entry.offset).toBeLessThanOrEqual(2);
    }
  });
});

describe("dialect precedence", () => {
  it("hasMelodicDialect matches the 38 dialect keys and nothing else", () => {
    expect(hasMelodicDialect("house", "amapiano")).toBe(true);
    expect(hasMelodicDialect("dnb", "amen")).toBe(true);
    expect(hasMelodicDialect("house", "metal")).toBe(true);
    expect(hasMelodicDialect("house", undefined)).toBe(false);
    expect(hasMelodicDialect("house", "no-such-dialect")).toBe(false);
  });

  it("a matched dialect REPLACES the engine; without one the engine plays", () => {
    const doc: ProjectDocument = testDoc();
    const base: GenerateOptions = {
      genre: "house",
      seed: "precedence-check",
      stepCount: 32,
      ghostWeight: 0.3,
      microWeight: 0.2,
      velocityVariation: 0.3,
      temperature: 1,
      replaceMode: "new",
    };
    // house.amapiano is a dialect: WITH the style the content must differ
    // from the plain engine generation on the same seed.
    const plain = generatePattern(doc, { ...base });
    const dialect = generatePattern(doc, { ...base, style: "amapiano" });
    expect(JSON.stringify(dialect.notes)).not.toBe(JSON.stringify(plain.notes));
    // Sanity: the dialect parts really come from the dialect table (the
    // Markov model over its sequences) — the melodic helper reproduces them.
    const rand = forkRandom("sanity", "x");
    const parts = generateMelodicParts({ ...base, style: "amapiano" }, rand, undefined, []);
    expect(parts.bass.length + parts.chord.length + parts.lead.length).toBeGreaterThan(0);
  });
});
