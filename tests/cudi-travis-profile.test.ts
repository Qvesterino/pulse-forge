import { describe, expect, it } from "vitest";
import { forkRandom } from "../src/shared/rng";
import { generatePattern } from "../src/ai/generator";
import { generateMelodicParts } from "../src/ai/melodic";
import { generateMultiVoice } from "../src/intent/multi-voice";
import { matchAllArtistPresets } from "../src/intent/artists";
import { generateOptionsFromIntent, planGeneration } from "../src/intent/plan";
import { normalizeIntent } from "../src/intent/normalize";
import { parseIntentText } from "../src/intent/text-parser";
import { testDoc } from "./fixtures/doc";

describe("Kid Cudi × Travis Scott production profile", () => {
  it("recognizes both artists and gives the blend a stable, non-averaged groove brief", () => {
    const prompt = "Kid Cudi meets Travis Scott type beat";
    expect(matchAllArtistPresets(prompt.toLowerCase()).map((match) => match.preset.label)).toEqual([
      "kid cudi",
      "travis scott",
    ]);

    const parsed = parseIntentText(prompt);
    expect(parsed.input.genre).toBe("trap");
    expect(parsed.input.style).toBe("rolling");
    expect(parsed.input.productionProfile).toBe("spacey-dark-trap");
    expect(parsed.input.mood).toBe("dark");
    expect(parsed.input.bpmRange).toEqual([128, 140]);
    expect(parsed.detected).toContain("♪ kid cudi × travis scott");

    const reversed = parseIntentText("Travis Scott meets Kid Cudi type beat");
    expect(reversed.input).toMatchObject({
      genre: parsed.input.genre,
      style: parsed.input.style,
      productionProfile: parsed.input.productionProfile,
      mood: parsed.input.mood,
      energy: parsed.input.energy,
      density: parsed.input.density,
      bpmRange: parsed.input.bpmRange,
    });
  });

  it("keeps explicit user direction above the reference preset", () => {
    const parsed = parseIntentText("Travis Scott meets Kid Cudi, bright, at 132 bpm");
    expect(parsed.input.productionProfile).toBe("spacey-dark-trap");
    expect(parsed.input.mood).toBe("energetic");
    expect(parsed.input.bpmRange).toEqual([132, 132]);
    expect(parseIntentText("Kid Cudi type beat techno").input.productionProfile).toBeUndefined();
  });

  it("selects a dedicated single-artist melodic profile for both references", () => {
    const cudi = normalizeIntent({ ...parseIntentText("Kid Cudi type beat").input, seed: "cudi-single", length: 64 });
    const travis = normalizeIntent({
      ...parseIntentText("Travis Scott type beat").input,
      seed: "travis-single",
      length: 64,
    });

    expect(cudi.productionProfile).toBe("spacey-melodic-rap");
    expect(travis.productionProfile).toBe("dark-atmospheric-trap");
    expect(planGeneration(cudi, testDoc()).groove.id).toBe("trap.lux");
    expect(planGeneration(travis, testDoc()).groove.id).toBe("trap.rolling");
  });

  it("carries the profile through normalization, planning and the saved generation recipe", () => {
    const parsed = parseIntentText("Kid Cudi meets Travis Scott type beat");
    const intent = normalizeIntent({ ...parsed.input, seed: "cudi-travis-profile", length: 64 });
    const plan = planGeneration(intent, testDoc());

    expect(plan.options.productionProfile).toBe("spacey-dark-trap");
    expect(plan.groove.id).toBe("trap.rolling");
    expect(plan.recipe.productionProfile).toBe("spacey-dark-trap");
    expect(generateOptionsFromIntent(intent).productionProfile).toBe("spacey-dark-trap");

    const generated = generatePattern(testDoc(), plan.options);
    expect(generated.generation?.productionProfile).toBe("spacey-dark-trap");
    expect(Object.values(generated.notes ?? {}).flat().length).toBeGreaterThan(0);
  });

  it("honors requested variation counts in English and Slovak through the generation plan", () => {
    const english = parseIntentText("Kid Cudi meets Travis Scott type beat, give me five variations");
    const intent = normalizeIntent({ ...english.input, seed: "five-artist-variations", length: 64 });
    const plan = planGeneration(intent, testDoc());

    expect(english.input.candidateCount).toBe(5);
    expect(plan.candidateSeeds).toHaveLength(5);
    expect(new Set(plan.candidateSeeds).size).toBe(5);
    expect(plan.options.productionProfile).toBe("spacey-dark-trap");

    const slovak = parseIntentText("sprav mi štyri varianty");
    expect(slovak.input.candidateCount).toBe(4);

    const capped = parseIntentText("daj mi 12 verzií");
    expect(capped.input.candidateCount).toBe(8);
    expect(capped.detected).toContain("8 variations (max 8)");
  });

  it("generates deterministic, key-safe profile melodies that differ from the generic trap prior", () => {
    const options = generateOptionsFromIntent(
      normalizeIntent({
        genre: "trap",
        productionProfile: "spacey-dark-trap",
        seed: "melodic-profile-fixture",
        length: 64,
      }),
    );
    const baselineOptions = { ...options, productionProfile: undefined };
    const profileA = generateMelodicParts(options, forkRandom("melodic-profile-fixture", "melody"), "C Natural Minor");
    const profileB = generateMelodicParts(options, forkRandom("melodic-profile-fixture", "melody"), "C Natural Minor");
    const baseline = generateMelodicParts(
      baselineOptions,
      forkRandom("melodic-profile-fixture", "melody"),
      "C Natural Minor",
    );
    const musicalContent = (parts: typeof profileA) =>
      Object.fromEntries(
        Object.entries(parts).map(([role, notes]) => [
          role,
          notes.map(({ pitch, start, duration, velocity }) => ({ pitch, start, duration, velocity })),
        ]),
      );
    const pitchClasses = new Set([0, 2, 3, 5, 7, 8, 10]); // C natural minor

    expect(musicalContent(profileA)).toEqual(musicalContent(profileB));
    expect(musicalContent(profileA)).not.toEqual(musicalContent(baseline));
    expect(profileA.bass.length).toBeGreaterThan(0);
    expect(profileA.chord.length).toBeGreaterThan(0);
    expect(profileA.lead.length).toBeGreaterThan(0);
    expect(
      Object.values(profileA)
        .flat()
        .every((note) => pitchClasses.has(note.pitch % 12)),
    ).toBe(true);
  });

  it("keeps symbolic multi-voice candidates inside the same spacious profile", () => {
    const profile = generateMultiVoice(testDoc(), "trap", 42, 64, null, 0.63, 0.3, 0.5, 0.5, "spacey-dark-trap");
    const baseline = generateMultiVoice(testDoc(), "trap", 42, 64, null, 0.63, 0.3, 0.5, 0.5);

    expect(profile.chord.length).toBeLessThan(baseline.chord.length);
    expect(profile.lead.length).toBeGreaterThan(0);
    expect(profile.lead.every((note) => note.duration === 4 * 120)).toBe(true);
  });
});
