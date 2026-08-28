import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { canonicalizePattern, contentHash } from "../src/ai/evaluation";
import { generatePattern } from "../src/ai/generator";
import type { GenerateOptions } from "../src/ai/types";
import { generateLocalResultFromOptions } from "../src/intent/pipeline";
import { canonicalizeIntent, intentHash } from "../src/intent/hash";
import { intentFromGenerateOptions, normalizeIntent } from "../src/intent/normalize";
import { isIntentSpec, parseIntentSpec } from "../src/intent/schema";
import { planGeneration } from "../src/intent/plan";

const options: GenerateOptions = {
  genre: "house",
  style: "Driving",
  seed: "intent-pipeline-test",
  stepCount: 32,
  ghostWeight: 0.3,
  microWeight: 0.2,
  velocityVariation: 0.3,
  temperature: 1,
  replaceMode: "new",
  applyGrooveSettings: false,
};

describe("intent contract and generation pipeline", () => {
  it("normalizes untrusted intent input into a versioned valid contract", () => {
    const intent = normalizeIntent({
      genre: "not-a-genre",
      length: 31,
      energy: 4,
      controls: { ghostWeight: -1, temperature: 10 },
    });

    expect(intent.version).toBe(1);
    expect(intent.genre).toBe("house");
    expect(intent.length).toBe(32);
    expect(intent.energy).toBe(1);
    expect(intent.controls.ghostWeight).toBe(0);
    expect(intent.controls.temperature).toBe(2);
    expect(isIntentSpec(intent)).toBe(true);
    expect(parseIntentSpec(JSON.parse(JSON.stringify(intent)))).toEqual(intent);
  });

  it("hashes the canonical intent independently of object insertion order", () => {
    const intent = intentFromGenerateOptions(options);
    const reordered = JSON.parse(JSON.stringify(intent)) as typeof intent;
    reordered.controls = {
      temperature: intent.controls.temperature,
      velocityVariation: intent.controls.velocityVariation,
      microWeight: intent.controls.microWeight,
      ghostWeight: intent.controls.ghostWeight,
    };

    expect(canonicalizeIntent(intent)).toBe(canonicalizeIntent(reordered));
    expect(intentHash(intent)).toBe(intentHash(reordered));
  });

  it("creates one deterministic plan for preview and apply", () => {
    const doc = createDefaultProject();
    const intent = intentFromGenerateOptions(options);
    const preview = planGeneration(intent, doc);
    const apply = planGeneration(intent, doc);

    expect(preview).toEqual(apply);
    expect(preview.outputShape).toEqual({
      stepCount: 32,
      roles: ["drums", "bass", "chords", "lead"],
      replaceMode: "new",
    });
    expect(preview.subSeeds.drumsCore).toContain("drums.core");
    expect(preview.recipe.grooveId).toBe("house.driving");
  });

  it("keeps local pipeline content identical to the frozen generator", () => {
    const doc = createDefaultProject();
    const direct = generatePattern(doc, options);
    const result = generateLocalResultFromOptions(doc, options, "preview");
    const proposal = result.proposal;

    expect(result.status).toBe("accepted");
    expect(proposal).toBeDefined();
    expect(contentHash(canonicalizePattern(doc, proposal!.pattern))).toBe(
      contentHash(canonicalizePattern(doc, direct)),
    );
    expect(proposal!.pattern.generation?.intentHash).toBe(result.plan.intentHash);
    expect(proposal!.pattern.generation?.intent).toEqual(result.plan.intent);
  });

  it("keeps normalized intent provenance through JSON round-trip", () => {
    const doc = createDefaultProject();
    const result = generateLocalResultFromOptions(doc, options);
    const roundTrip = JSON.parse(JSON.stringify(result.proposal!.pattern));

    expect(roundTrip.generation.intentHash).toBe(result.plan.intentHash);
    expect(roundTrip.generation.intent).toEqual(result.plan.intent);
    expect(roundTrip.generation.outputContentHash).toBe(result.proposal!.pattern.generation?.outputContentHash);
  });
});
