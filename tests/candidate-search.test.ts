import { describe, expect, it } from "vitest";
import { generatePattern, resolveGrooveForGeneration } from "../src/ai/generator";
import { GENRES, type GrooveData } from "../src/ai/types";
import { getGroovesForGenre } from "../src/ai/grooves";
import { STEP_TICKS } from "../src/project-model/types";
import { createDefaultProject } from "../src/project-model/schema";
import {
  applyCandidateSearchFamily,
  candidateSearchVariant,
  searchLaneForCandidate,
} from "../src/intent/candidate-search";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import type { PersonalSearchBias } from "../src/intent/personal-ranker";

const doc = createDefaultProject();
const plan = planGeneration(
  normalizeIntent({
    genre: "trap",
    seed: "lane-test",
    energy: 0.55,
    density: 0.42,
    complexity: 0.61,
    variation: 0.33,
    roles: ["drums", "bass", "lead"],
    preserve: ["bass"],
    length: 64,
    key: doc.key,
    candidateCount: 3,
    constraints: { preserveAnchors: true, allowGhosts: false, allowSwing: true },
  }),
  doc,
);

const bias: PersonalSearchBias = {
  energy: 0.12,
  density: -0.1,
  complexity: 0.08,
  variation: -0.04,
  motifRepetition: 0.08,
  grooveSyncopation: 0.08,
  evidenceCount: 4,
};

describe("Producer DNA candidate search lanes", () => {
  it("assigns stable SAFE, PERSONAL, EXPERIMENTAL lanes", () => {
    expect([0, 1, 2, 3, 4, 5].map(searchLaneForCandidate)).toEqual([
      "safe",
      "personal",
      "experimental",
      "safe",
      "personal",
      "experimental",
    ]);
  });

  it("keeps SAFE on the legacy plan and seed", () => {
    const seed = plan.candidateSeeds[0];
    const result = candidateSearchVariant(plan, seed, 0, bias);
    expect(result.search).toMatchObject({ lane: "safe", mode: "baseline" });
    expect(result.generationPlan.options).toEqual({ ...plan.options, seed });
    expect(result.generationPlan.intent).toEqual(plan.intent);
    expect(result.validationPlan.intent).toEqual(plan.intent);
  });

  it("nudges only soft intent axes for PERSONAL and preserves hard brief fields", () => {
    const result = candidateSearchVariant(plan, "personal-seed", 1, bias);
    expect(result.search).toMatchObject({ lane: "personal", mode: "personalized" });
    expect(result.search.melodyFamily).toBe("repeating-hook");
    expect(result.search.family).toBe("personal-groove");
    expect(result.search.grooveId).toBeTruthy();
    expect(result.generationPlan.intent.energy).toBeCloseTo(plan.intent.energy + bias.energy);
    expect(result.generationPlan.intent.density).toBeCloseTo(plan.intent.density + bias.density);
    expect(result.generationPlan.intent.complexity).toBeCloseTo(plan.intent.complexity + bias.complexity);
    expect(result.generationPlan.intent.variation).toBeCloseTo(plan.intent.variation + bias.variation);
    expect(result.generationPlan.intent.roles).toEqual(plan.intent.roles);
    expect(result.generationPlan.intent.preserve).toEqual(plan.intent.preserve);
    expect(result.generationPlan.intent.key).toBe(plan.intent.key);
    expect(result.generationPlan.intent.length).toBe(plan.intent.length);
    expect(result.generationPlan.intent.constraints).toEqual(plan.intent.constraints);
    expect(result.generationPlan.options.stepCount).toBe(plan.options.stepCount);
    expect(result.generationPlan.options.roles).toEqual(plan.options.roles);
    expect(result.validationPlan.intent).toEqual(plan.intent);
    expect(result.generationPlan.options.seed).toContain("search:v1:personal");
  });

  it("marks a no-evidence PERSONAL lane as cold-start without inventing a preference", () => {
    const result = candidateSearchVariant(plan, "cold-seed", 1, null);
    expect(result.search.mode).toBe("cold-start");
    expect(result.generationPlan.intent.energy).toBe(plan.intent.energy);
    expect(result.generationPlan.intent.density).toBe(plan.intent.density);
    expect(result.generationPlan.options.seed).toContain("search:v1:personal");
    expect(result.search.grooveId).toBeUndefined();
  });

  it("only adds a personal repeating-hook family for a sufficiently strong learned motif preference", () => {
    const noveltyBias = { ...bias, motifRepetition: -0.08 };
    const smallBias = { ...bias, motifRepetition: 0.01 };

    expect(candidateSearchVariant(plan, "novelty-seed", 1, noveltyBias).search.melodyFamily).toBeUndefined();
    expect(candidateSearchVariant(plan, "small-signal-seed", 1, smallBias).search.melodyFamily).toBeUndefined();
    expect(candidateSearchVariant(plan, "cold-seed", 1, null).search.melodyFamily).toBeUndefined();

    const personal = candidateSearchVariant(plan, "learned-hook-seed", 1, bias);
    expect(personal.search.melodyFamily).toBe("repeating-hook");
    const generated = generatePattern(doc, personal.generationPlan.options);
    const prepared = applyCandidateSearchFamily(generated, doc, personal.generationPlan, personal.search);
    expect(prepared.search.melodyFamily).toBe("repeating-hook");
    const leadTargets = new Set(personal.generationPlan.rolePlans.lead.targetTrackIds);
    const leadTracks = doc.tracks.filter((track) => track.kind === "instrument" && leadTargets.has(track.id));
    const leadTrack =
      leadTracks.find((track) => track.name.toLowerCase().includes("lead")) ?? leadTracks[2 % leadTracks.length];
    expect(leadTrack).toBeDefined();
    const notes = prepared.pattern.notes?.[leadTrack!.id] ?? [];
    const barTicks = 16 * STEP_TICKS;
    const motifInBar = (bar: number) =>
      notes
        .filter((note) => note.start >= bar * barTicks && note.start < (bar + 1) * barTicks)
        .map(({ start, pitch, duration, velocity }) => ({ start: start - bar * barTicks, pitch, duration, velocity }));
    expect(motifInBar(0).length).toBeGreaterThan(0);
    expect(motifInBar(1)).toEqual(motifInBar(0));
  });

  it("creates deterministic, bounded experimental variations without changing hard constraints", () => {
    const first = candidateSearchVariant(plan, "experimental-seed", 2, bias);
    const replay = candidateSearchVariant(plan, "experimental-seed", 2, bias);
    expect(first).toEqual(replay);
    expect(first.search).toMatchObject({ lane: "experimental", mode: "experimental" });
    for (const axis of ["energy", "density", "complexity", "variation"] as const) {
      expect(first.generationPlan.intent[axis]).toBeGreaterThanOrEqual(0);
      expect(first.generationPlan.intent[axis]).toBeLessThanOrEqual(1);
    }
    expect(first.generationPlan.intent.roles).toEqual(plan.intent.roles);
    expect(first.generationPlan.intent.constraints).toEqual(plan.intent.constraints);
    expect(first.generationPlan.options.key).toBe(plan.options.key);
    expect(first.generationPlan.options.stepCount).toBe(plan.options.stepCount);
  });

  it("generates a real same-genre alternate groove for EXPERIMENTAL when drums are in scope", () => {
    const safe = candidateSearchVariant(plan, plan.candidateSeeds[0], 0, bias);
    const experimental = candidateSearchVariant(plan, "experimental-groove-seed", 2, bias);

    expect(experimental.search.family).toBe("alternate-groove");
    expect(experimental.search.melodyFamily).toBe("repeating-hook");
    expect(experimental.search.grooveId).toBeTruthy();
    expect(experimental.search.grooveId).not.toBe(plan.groove.id);
    expect(experimental.generationPlan.intent.genre).toBe(plan.intent.genre);
    expect(experimental.generationPlan.options.style).toBe(experimental.generationPlan.groove.name);
    expect(resolveGrooveForGeneration(doc, experimental.generationPlan.options).id).toBe(experimental.search.grooveId);

    const safePattern = generatePattern(doc, safe.generationPlan.options);
    const experimentalPattern = generatePattern(doc, experimental.generationPlan.options);
    const prepared = applyCandidateSearchFamily(
      experimentalPattern,
      doc,
      experimental.generationPlan,
      experimental.search,
    );
    expect(experimentalPattern.generation?.grooveId).toBe(experimental.search.grooveId);
    expect(experimentalPattern.rows).not.toEqual(safePattern.rows);
    expect(prepared.search.melodyFamily).toBe("repeating-hook");
    expect(experimental.validationPlan.groove).toEqual(plan.groove);
    expect(experimental.validationPlan.intent.constraints).toEqual(plan.intent.constraints);

    const leadTrackIds = new Set(experimental.generationPlan.rolePlans.lead.targetTrackIds);
    const instrumentTracks = doc.tracks.filter((track) => track.kind === "instrument" && leadTrackIds.has(track.id));
    expect(instrumentTracks.length).toBeGreaterThan(0);
    const leadTrack =
      instrumentTracks.find((track) => track.name.toLowerCase().includes("lead")) ??
      instrumentTracks[2 % instrumentTracks.length];
    expect(leadTrack).toBeDefined();
    const leadNotes = prepared.pattern.notes?.[leadTrack!.id] ?? [];
    const barTicks = 16 * STEP_TICKS;
    const motifInBar = (bar: number) =>
      leadNotes
        .filter((note) => note.start >= bar * barTicks && note.start < (bar + 1) * barTicks)
        .map(({ start, pitch, duration, velocity }) => ({ start: start - bar * barTicks, pitch, duration, velocity }));
    expect(motifInBar(0).length).toBeGreaterThan(0);
    for (let bar = 1; bar < Math.ceil(prepared.pattern.stepCount / 16); bar++) {
      expect(motifInBar(bar)).toEqual(motifInBar(0));
    }
    expect(prepared.pattern.generation?.quality?.melodicMotifRepetition).toBeDefined();
  });

  it("does not replace an explicit style or vary the groove when drums are protected", () => {
    const explicitStylePlan = planGeneration(normalizeIntent({ ...plan.intent, style: plan.groove.name }), doc);
    const explicitStyle = candidateSearchVariant(explicitStylePlan, "explicit-style", 2, bias);
    expect(explicitStyle.search.family).toBe("soft-axis");
    expect(explicitStyle.search.grooveId).toBeUndefined();
    expect(explicitStyle.generationPlan.options.style).toBe(plan.groove.name);

    const protectedDrumsPlan = planGeneration(normalizeIntent({ ...plan.intent, preserve: ["drums"] }), doc);
    const protectedDrums = candidateSearchVariant(protectedDrumsPlan, "protected-drums", 2, bias);
    expect(protectedDrums.search.family).toBe("soft-axis");
    expect(protectedDrums.search.grooveId).toBeUndefined();
  });

  it("chooses only same-genre grooves in the direction of explicit syncopation preference", () => {
    const negativeBias = { ...bias, motifRepetition: 0, grooveSyncopation: -0.12 };
    const baseGroove = getGroovesForGenre(plan.intent.genre).find((groove) => groove.id === plan.groove.id)!;
    const score = (groove: GrooveData) => {
      let hits = 0;
      let syncopated = 0;
      for (const pattern of groove.patterns) {
        for (const velocities of Object.values(pattern)) {
          velocities.slice(0, 16).forEach((velocity, step) => {
            if (velocity <= 0) return;
            hits += 1;
            if (step % 4 === 1 || step % 4 === 3) syncopated += 1;
          });
        }
      }
      return hits > 0 ? syncopated / hits : 0;
    };

    const moreSyncopated = candidateSearchVariant(plan, "personal-syncopated", 1, bias);
    const lessSyncopated = candidateSearchVariant(plan, "personal-straight", 1, negativeBias);
    expect(moreSyncopated.search.family).toBe("personal-groove");
    expect(lessSyncopated.search.family).toBe("personal-groove");
    const moreGroove = getGroovesForGenre(plan.intent.genre).find(
      (groove) => groove.id === moreSyncopated.search.grooveId,
    );
    const lessGroove = getGroovesForGenre(plan.intent.genre).find(
      (groove) => groove.id === lessSyncopated.search.grooveId,
    );
    expect(moreGroove).toBeDefined();
    expect(lessGroove).toBeDefined();
    expect(moreGroove?.genre).toBe(plan.intent.genre);
    expect(lessGroove?.genre).toBe(plan.intent.genre);
    expect(score(moreGroove!)).toBeGreaterThan(score(baseGroove));
    expect(score(lessGroove!)).toBeLessThan(score(baseGroove));
  });

  it("keeps groove-family alternatives inside each supported genre", () => {
    for (const genre of GENRES) {
      const genrePlan = planGeneration(
        normalizeIntent({ genre, seed: `groove-family-${genre}`, roles: ["drums"], candidateCount: 3 }),
        doc,
      );
      const experimental = candidateSearchVariant(genrePlan, `groove-family-${genre}`, 2, null);
      const genreGrooves = getGroovesForGenre(genre);

      expect(experimental.generationPlan.intent.genre).toBe(genre);
      if (genreGrooves.length > 1) {
        expect(experimental.search.family).toBe("alternate-groove");
        expect(genreGrooves.some((groove) => groove.id === experimental.search.grooveId)).toBe(true);
        expect(experimental.search.grooveId).not.toBe(genrePlan.groove.id);
        expect(resolveGrooveForGeneration(doc, experimental.generationPlan.options).id).toBe(
          experimental.search.grooveId,
        );
      } else {
        expect(experimental.search.family).toBe("soft-axis");
      }
    }
  });
});
