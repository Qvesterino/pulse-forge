import { describe, expect, it } from "vitest";
import { generatePattern, resolveGrooveForGeneration } from "../src/ai/generator";
import { extractPatternFeatures, FEATURE_COUNT, FEATURE_NAMES } from "../src/ai/features/pattern-features";
import { GENRES, type GrooveData } from "../src/ai/types";
import { getGroovesForGenre } from "../src/ai/grooves";
import { STEP_TICKS } from "../src/project-model/types";
import { createDefaultProject } from "../src/project-model/schema";
import {
  applyCandidateSearchFamily,
  candidateSearchVariant,
  searchLaneForCandidate,
  selectPersonalGrooveCandidate,
} from "../src/intent/candidate-search";
import { evaluateCandidate } from "../src/intent/providers/candidate";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { inferPersonalSearchBias, type PersonalSearchBias } from "../src/intent/personal-ranker";
import {
  createPreferenceObservation,
  PREFERENCE_LEDGER_KEY,
  PREFERENCE_LEARNING_KEY,
  preferenceContextForIntent,
} from "../src/intent/preference-ledger";
import { LocalDeterministicProvider } from "../src/intent/providers/local";

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
    expect(experimental.search.melodyFamily).toBe("evolving-hook");
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
    expect(prepared.search.melodyFamily).toBe("evolving-hook");
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
    expect(leadNotes.every((note) => note.duration % STEP_TICKS === 0)).toBe(true);
    const motifInBar = (bar: number) =>
      leadNotes
        .filter((note) => note.start >= bar * barTicks && note.start < (bar + 1) * barTicks)
        .map(({ start, pitch, duration, velocity }) => ({ start: start - bar * barTicks, pitch, duration, velocity }));
    expect(motifInBar(0).length).toBeGreaterThan(0);
    const firstMotif = motifInBar(0);
    const secondMotif = motifInBar(1);
    expect(secondMotif.length).toBeGreaterThan(0);
    expect(secondMotif.length).toBeGreaterThanOrEqual(firstMotif.length - 1);
    expect(secondMotif.slice(0, -1)).toEqual(firstMotif.slice(0, secondMotif.length - 1));
    const firstEnding = firstMotif.at(-1)!;
    const secondEnding = secondMotif.at(-1)!;
    expect(secondMotif.length < firstMotif.length || secondEnding.duration < firstEnding.duration).toBe(true);
    expect(motifInBar(2)).toEqual(firstMotif);
    expect(prepared.pattern.generation?.quality?.melodicMotifRepetition).toBeDefined();
  });

  it("does not report an evolving hook when a one-note motif cannot be changed", () => {
    const leadOnlyPlan = planGeneration(normalizeIntent({ ...plan.intent, roles: ["lead"], preserve: [] }), doc);
    const variant = candidateSearchVariant(leadOnlyPlan, "one-note-hook-seed", 2, bias);
    expect(variant.search.melodyFamily).toBe("evolving-hook");
    const generated = generatePattern(doc, variant.generationPlan.options);
    const targetIds = new Set(variant.generationPlan.rolePlans.lead.targetTrackIds);
    const leadTracks = doc.tracks.filter((track) => track.kind === "instrument" && targetIds.has(track.id));
    const leadTrack =
      leadTracks.find((track) => track.name.toLowerCase().includes("lead")) ?? leadTracks[2 % leadTracks.length];
    expect(leadTrack).toBeDefined();
    const firstNote = generated.notes?.[leadTrack!.id]?.find((note) => note.start < 16 * STEP_TICKS);
    expect(firstNote).toBeDefined();

    const oneNotePattern = {
      ...generated,
      notes: {
        ...generated.notes,
        [leadTrack!.id]: [{ ...firstNote!, start: 0, duration: STEP_TICKS }],
      },
    };
    const prepared = applyCandidateSearchFamily(oneNotePattern, doc, variant.generationPlan, variant.search);
    expect(prepared.pattern).toBe(oneNotePattern);
    expect(prepared.search.melodyFamily).toBeUndefined();
    expect(prepared.search.family).toBe("soft-axis");
  });

  it("does not replace an explicit style or vary the groove when drums are protected", () => {
    const explicitStylePlan = planGeneration(normalizeIntent({ ...plan.intent, style: plan.groove.name }), doc);
    const explicitStyle = candidateSearchVariant(explicitStylePlan, "explicit-style", 2, bias);
    expect(explicitStyle.search.family).toBe("evolving-hook");
    expect(explicitStyle.search.melodyFamily).toBe("evolving-hook");
    expect(explicitStyle.search.grooveId).toBeUndefined();
    expect(explicitStyle.generationPlan.options.style).toBe(plan.groove.name);

    const protectedDrumsPlan = planGeneration(normalizeIntent({ ...plan.intent, preserve: ["drums"] }), doc);
    const protectedDrums = candidateSearchVariant(protectedDrumsPlan, "protected-drums", 2, bias);
    expect(protectedDrums.search.family).toBe("evolving-hook");
    expect(protectedDrums.search.melodyFamily).toBe("evolving-hook");
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

    // The template proxy is not enough: make sure the selected lane changes
    // the actual generated drum pattern in the same measured direction.
    const seed = plan.intent.seed;
    const safeVariant = candidateSearchVariant(plan, seed, 0, null);
    const safePattern = evaluateCandidate(
      generatePattern(doc, safeVariant.generationPlan.options),
      safeVariant.validationPlan,
      { project: doc, mode: "preview" },
    )?.pattern;
    expect(safePattern).toBeDefined();
    const measuredSyncopation = (pattern: typeof safePattern, variant: ReturnType<typeof candidateSearchVariant>) => {
      if (!pattern) throw new Error("expected a valid generated pattern");
      const feature = extractPatternFeatures({
        doc,
        pattern,
        intent: variant.validationPlan.intent,
        options: variant.generationPlan.options,
        resolvedBpm: variant.validationPlan.resolvedBpm,
      }).values[FEATURE_NAMES.indexOf("drums.syncopation")];
      return feature ?? Number.NaN;
    };
    const safeSyncopation = measuredSyncopation(safePattern, safeVariant);
    const selectAndMeasure = (personalBias: PersonalSearchBias) =>
      selectPersonalGrooveCandidate({
        plan,
        seed,
        candidateIndex: 1,
        personalBias,
        baselineSyncopation: safeSyncopation,
        build: (variant) => {
          const generated = generatePattern(doc, variant.generationPlan.options);
          const prepared = applyCandidateSearchFamily(generated, doc, variant.generationPlan, variant.search).pattern;
          const evaluated = evaluateCandidate(prepared, variant.validationPlan, { project: doc, mode: "preview" });
          if (!evaluated) return null;
          return {
            candidate: evaluated.pattern,
            syncopation: measuredSyncopation(evaluated.pattern, variant),
          };
        },
      });

    const moreResult = selectAndMeasure(bias);
    const lessResult = selectAndMeasure(negativeBias);
    expect(moreResult.candidate).not.toBeNull();
    expect(lessResult.candidate).not.toBeNull();
    if (moreResult.candidate === null || lessResult.candidate === null) {
      throw new Error("expected both directions to produce a measured personal groove candidate");
    }
    expect(moreResult.outputDelta).toBeGreaterThanOrEqual(0.01);
    expect(lessResult.outputDelta).toBeGreaterThanOrEqual(0.01);
    expect(moreResult.attempts).toBeGreaterThanOrEqual(1);
    expect(moreResult.attempts).toBeLessThanOrEqual(16);
    expect(measuredSyncopation(moreResult.candidate, moreResult.variant)).toBeGreaterThan(safeSyncopation);
    expect(measuredSyncopation(lessResult.candidate, lessResult.variant)).toBeLessThan(safeSyncopation);
  });

  it("routes real local A/B groove observations into the PERSONAL groove family", () => {
    const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");
    const offbeatIndex = FEATURE_NAMES.indexOf("drums.offbeatRatio");
    const preferred = new Array<number>(FEATURE_COUNT).fill(0.5);
    const rejected = new Array<number>(FEATURE_COUNT).fill(0.5);
    preferred[syncopationIndex] = 0.9;
    rejected[syncopationIndex] = 0.1;
    preferred[offbeatIndex] = 0.9;
    rejected[offbeatIndex] = 0.1;
    const context = preferenceContextForIntent(plan.intent);
    const observation = (suffix: string, createdAt: number) => {
      const result = createPreferenceObservation(
        context,
        { contentHash: `preferred-${suffix}`, features: preferred },
        { contentHash: `rejected-${suffix}`, features: rejected },
        "a",
        { reason: "groove", createdAt },
      );
      if (!result) throw new Error("test preference observation invalid");
      return result;
    };
    const bias = inferPersonalSearchBias([observation("a", 1), observation("b", 2)], context);
    expect(bias?.grooveSyncopation).toBeGreaterThan(0.025);

    const personal = candidateSearchVariant(plan, "learned-groove-seed", 1, bias);
    expect(personal.search.lane).toBe("personal");
    expect(personal.search.mode).toBe("personalized");
    expect(personal.search.family).toBe("personal-groove");
    expect(personal.search.grooveId).not.toBe(plan.groove.id);
    expect(personal.generationPlan.options.style).toBe(personal.generationPlan.groove.name);
    expect(resolveGrooveForGeneration(doc, personal.generationPlan.options).id).toBe(personal.search.grooveId);
  });

  it("keeps a generated PERSONAL groove only when the gated pattern moves in the learned direction", async () => {
    const syncopationIndex = FEATURE_NAMES.indexOf("drums.syncopation");
    const offbeatIndex = FEATURE_NAMES.indexOf("drums.offbeatRatio");
    const preferred = new Array<number>(FEATURE_COUNT).fill(0.5);
    const rejected = new Array<number>(FEATURE_COUNT).fill(0.5);
    preferred[syncopationIndex] = 0.9;
    rejected[syncopationIndex] = 0.1;
    preferred[offbeatIndex] = 0.9;
    rejected[offbeatIndex] = 0.1;
    const context = preferenceContextForIntent(plan.intent);
    const observations = ["a", "b"].map((suffix, index) => {
      const observation = createPreferenceObservation(
        context,
        { contentHash: `integration-preferred-${suffix}`, features: preferred },
        { contentHash: `integration-rejected-${suffix}`, features: rejected },
        "a",
        { reason: "groove", createdAt: index + 1 },
      );
      if (!observation) throw new Error("test preference observation invalid");
      return observation;
    });

    const previousLedger = localStorage.getItem(PREFERENCE_LEDGER_KEY);
    const previousLearning = localStorage.getItem(PREFERENCE_LEARNING_KEY);
    const previousRanker = localStorage.getItem("pf:intent-ranker");
    localStorage.setItem(PREFERENCE_LEDGER_KEY, JSON.stringify(observations));
    localStorage.setItem(PREFERENCE_LEARNING_KEY, "on");
    localStorage.setItem("pf:intent-ranker", "off");
    try {
      const result = await new LocalDeterministicProvider().generateRanked(plan, { project: doc, mode: "preview" });
      const personal = result.ranked.find((candidate) => candidate.candidateIndex === 1);
      expect(personal?.search).toMatchObject({
        lane: "personal",
        family: "personal-groove",
        mode: "personalized",
      });
      expect(personal?.search?.measuredSyncopationDelta).toBeGreaterThanOrEqual(0.01);
      expect(personal?.search?.grooveSeedAttempts).toBeGreaterThanOrEqual(1);
      expect(personal?.search?.grooveSeedAttempts).toBeLessThanOrEqual(16);
    } finally {
      if (previousLedger === null) localStorage.removeItem(PREFERENCE_LEDGER_KEY);
      else localStorage.setItem(PREFERENCE_LEDGER_KEY, previousLedger);
      if (previousLearning === null) localStorage.removeItem(PREFERENCE_LEARNING_KEY);
      else localStorage.setItem(PREFERENCE_LEARNING_KEY, previousLearning);
      if (previousRanker === null) localStorage.removeItem("pf:intent-ranker");
      else localStorage.setItem("pf:intent-ranker", previousRanker);
    }
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
