import { describe, expect, it } from "vitest";
import { buildTheatrePlan, stageLabel } from "../src/intent/producer-theatre";
import { PRODUCER_PERSONAS, defaultCast, personaBySlug } from "../src/intent/producer-personas";

/**
 * SESSION THEATRE — pure orchestration contract (AGENTS determinism
 * invariant #4): same brief + cast + interjections → same prompts, seeds,
 * stage script. The persona RECOLORS the user brief, never replaces it.
 */

describe("producer personas", () => {
  it("curated cast exists with distinct genres and seed tags", () => {
    expect(PRODUCER_PERSONAS.length).toBeGreaterThanOrEqual(5);
    const genres = new Set(PRODUCER_PERSONAS.map((persona) => persona.genre));
    expect(genres.size).toBeGreaterThanOrEqual(4);
    const tags = new Set(PRODUCER_PERSONAS.map((persona) => persona.seedTag));
    expect(tags.size).toBe(PRODUCER_PERSONAS.length);
  });

  it("personaBySlug is deterministic; unknown slug → null", () => {
    expect(personaBySlug("katarina-afterhours")?.name).toContain("Katarína");
    expect(personaBySlug("no-such-producer")).toBeNull();
  });
});

describe("theatre plan — pure orchestration", () => {
  const brief = "dark melodic techno, afterhours";

  it("builds one run per cast member with flavored prompts + distinct seeds", () => {
    const plan = buildTheatrePlan({ brief });
    expect(plan.length).toBe(3);
    const seeds = new Set(plan.map((run) => run.seed));
    expect(seeds.size).toBe(plan.length);
    for (const run of plan) {
      // brief is ALWAYS present (persona recolors, never replaces)
      expect(run.prompt.toLowerCase()).toContain("dark melodic techno");
      expect(run.prompt.length).toBeGreaterThan(brief.length);
      expect(run.stages.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("different personas recolor the SAME brief differently (default cast used)", () => {
    const plan = buildTheatrePlan({ brief, cast: defaultCast() });
    const prompts = new Set(plan.map((run) => run.prompt));
    expect(prompts.size).toBe(plan.length);
  });

  it("DETERMINISM: same input → identical runs", () => {
    const a = buildTheatrePlan({ brief });
    const b = buildTheatrePlan({ brief });
    expect(a).toEqual(b);
  });

  it("interjections stack onto the targeted producer only", () => {
    const slug = PRODUCER_PERSONAS[1].slug;
    const plan = buildTheatrePlan({
      brief,
      interjections: [{ producerSlug: slug, note: "more bass, less hats" }],
    });
    const targeted = plan.find((run) => run.producerSlug === slug)!;
    expect(targeted.prompt).toContain("more bass, less hats");
    // untouched producers stay clean
    for (const run of plan) {
      if (run.producerSlug === slug) continue;
      expect(run.prompt).not.toContain("more bass, less hats");
    }
  });

  it("stageLabel streams without overflow", () => {
    const plan = buildTheatrePlan({ brief });
    expect(stageLabel(plan[0], 0)).toContain("reading the brief");
    expect(stageLabel(plan[0], 99)).toContain(plan[0].name);
  });

  it("RETAKE bumps the seed version with no note (fresh take, same voice)", () => {
    const cast = PRODUCER_PERSONAS.slice(0, 1);
    const [original] = buildTheatrePlan({ brief, cast });
    const nextVersion = (seed: string) => (Number(/v(\d+)$/.exec(seed)?.[1] ?? 0) || 0) + 1;
    const [retake] = buildTheatrePlan({ brief, cast, retake: nextVersion(original.seed) });
    expect(retake.seed).not.toBe(original.seed);
    expect(retake.prompt).toBe(original.prompt); // no note → same prompt voice
    // successive no-note retakes keep flipping the seed
    const [retake2] = buildTheatrePlan({ brief, cast, retake: nextVersion(retake.seed) });
    expect(retake2.seed).not.toBe(retake.seed);
    // and an interjection still changes BOTH prompt and seed
    const [noted] = buildTheatrePlan({
      brief,
      cast,
      interjections: [{ producerSlug: PRODUCER_PERSONAS[0].slug, note: "menej hi-hatov" }],
    });
    expect(noted.prompt).toContain("menej hi-hatov");
    expect(noted.seed).not.toBe(original.seed);
  });
});
