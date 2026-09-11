import { describe, expect, it } from "vitest";
import { generatePattern } from "../src/ai/generator";
import { inspectPatternInvariants } from "../src/ai/invariants";
import { generatePatternCommand } from "../src/commands/commands";
import { rankCandidateBank } from "../src/intent/candidate-bank";
import { LocalDeterministicProvider } from "../src/intent/providers/local";
import { generateLocalResult } from "../src/intent/pipeline";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { createDefaultProject } from "../src/project-model/schema";
import { isInScale } from "../src/project-model/scales";
import type { GenerateOptions } from "../src/ai/types";

const baseOptions: GenerateOptions = {
  genre: "house",
  style: "Driving",
  seed: "binding-test",
  stepCount: 32,
  ghostWeight: 0.3,
  microWeight: 0.2,
  velocityVariation: 0.3,
  temperature: 1,
  replaceMode: "new",
  applyGrooveSettings: false,
};

describe("Intent binding", () => {
  it("binds explicit key through the plan into every melodic output note", () => {
    const doc = createDefaultProject();
    const intent = normalizeIntent({
      ...baseOptions,
      key: "D Natural Minor",
      roles: ["bass", "chords", "lead"],
      length: 64,
    });
    const result = generateLocalResult(doc, intent, "preview");
    const notes = Object.values(result.proposal!.pattern.notes).flat();

    expect(result.plan.options.key).toBe("D Natural Minor");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((note) => isInScale(note.pitch, "D Natural Minor"))).toBe(true);
    expect(
      inspectPatternInvariants(doc, result.proposal!.pattern, { checkScale: true, key: "D Natural Minor" }).ok,
    ).toBe(true);
  });

  it("binds BPM range deterministically and applies the resolved BPM in the command", () => {
    const doc = createDefaultProject();
    const intent = normalizeIntent({ ...baseOptions, bpmRange: [100, 110] });
    const plan = planGeneration(intent, doc);

    expect(plan.resolvedBpm).toBeGreaterThanOrEqual(100);
    expect(plan.resolvedBpm).toBeLessThanOrEqual(110);
    expect(plan.resolvedBpm).toBe(planGeneration(intent, doc).resolvedBpm);

    const next = generatePatternCommand(doc, { ...baseOptions, bpmRange: [100, 110] }).execute(doc);
    expect(next.bpm).toBe(plan.resolvedBpm);
  });

  it("does not emit disabled melodic roles and carries hard constraints into options", () => {
    const doc = createDefaultProject();
    const intent = normalizeIntent({
      ...baseOptions,
      roles: ["drums", "bass"],
      constraints: { preserveAnchors: false, allowGhosts: false, allowSwing: false },
      controls: { ...baseOptions, microWeight: 0, ghostWeight: 1 },
    });
    const result = generateLocalResult(doc, intent, "preview");
    const chordTrack = doc.tracks.find((track) => track.kind === "instrument" && track.name === "Chords");

    expect(result.plan.options.roles).toEqual(["drums", "bass"]);
    expect(result.plan.options.constraints).toEqual({
      preserveAnchors: false,
      allowGhosts: false,
      allowSwing: false,
    });
    expect(chordTrack).toBeDefined();
    expect(result.proposal!.pattern.notes[chordTrack!.id] ?? []).toHaveLength(0);
    const meta = Object.values(result.proposal!.pattern.stepMeta ?? {}).flatMap((steps) => Object.values(steps));
    expect(meta.some((step) => step.microtiming !== undefined)).toBe(false);
  });
});

describe("truthful local generation diagnostics", () => {
  it("reports repaired only when the invariant repair path was used", () => {
    const doc = createDefaultProject();
    const plan = planGeneration(normalizeIntent(baseOptions), doc);
    const brokenProvider = new LocalDeterministicProvider((project, options) => {
      const generated = generatePattern(project, options);
      const padId = Object.keys(generated.rows)[0];
      return {
        ...generated,
        rows: { ...generated.rows, [padId]: generated.rows[padId].slice(1) },
      };
    });

    const proposal = brokenProvider.generateSync(plan, { project: doc, mode: "preview" });
    expect(proposal.status).toBe("repaired");
    expect(proposal.diagnostics.repairs.length).toBeGreaterThan(0);
    expect(proposal.diagnostics.errors).toEqual([]);
    expect(inspectPatternInvariants(doc, proposal.pattern).ok).toBe(true);
  });

  it("reports fallback with a reason when the primary generator throws", () => {
    const doc = createDefaultProject();
    const plan = planGeneration(normalizeIntent(baseOptions), doc);
    const failingProvider = new LocalDeterministicProvider(() => {
      throw new Error("synthetic generator failure");
    });

    const proposal = failingProvider.generateSync(plan, { project: doc, mode: "preview" });
    expect(proposal.status).toBe("fallback");
    expect(proposal.diagnostics.repairs).toEqual([]);
    expect(proposal.diagnostics.fallbackReason).toContain("synthetic generator failure");
    expect(inspectPatternInvariants(doc, proposal.pattern).ok).toBe(true);
  });
});

describe("offline candidate bank", () => {
  it("generates stable seeded candidates and selects the highest quality candidate", () => {
    const doc = createDefaultProject();
    const plan = planGeneration(normalizeIntent({ ...baseOptions, candidateCount: 3 }), doc);
    const seenSeeds: string[] = [];
    const provider = new LocalDeterministicProvider((project, options) => {
      seenSeeds.push(options.seed);
      const generated = generatePattern(project, options);
      const candidateIndex = plan.candidateSeeds.indexOf(options.seed);
      const quality = generated.generation!.quality!;
      return {
        ...generated,
        generation: {
          ...generated.generation!,
          quality: {
            ...quality,
            styleAccepted: candidateIndex === 2,
            styleDistance: candidateIndex === 2 ? 0 : 1,
            anchorCoverage: candidateIndex === 2 ? 1 : 0,
            melodicMotifRepetition: candidateIndex === 2 ? 1 : 0,
          },
        },
      };
    });

    const proposal = provider.generateSync(plan, { project: doc, mode: "preview" });
    expect(seenSeeds).toEqual(plan.candidateSeeds);
    expect(proposal.status).toBe("accepted");
    expect(proposal.diagnostics.repairs).toEqual([]);
    expect(proposal.diagnostics.warnings).toContain("candidate-bank-enabled");
    expect(proposal.diagnostics.warnings).toContain("candidate-bank-selected:2");
    expect(proposal.pattern.generation?.candidateCount).toBe(3);
  });

  it("deduplicates identical musical candidates by UUID-free content hash", () => {
    const doc = createDefaultProject();
    const pattern = generatePattern(doc, baseOptions);
    const ranked = rankCandidateBank(doc, [
      { candidateIndex: 0, seed: "a", pattern, status: "accepted", repairs: [], score: 0, contentHash: "" },
      { candidateIndex: 1, seed: "b", pattern: { ...pattern, id: "different-id" }, status: "accepted", repairs: [], score: 0, contentHash: "" },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].candidateIndex).toBe(0);
  });
});
