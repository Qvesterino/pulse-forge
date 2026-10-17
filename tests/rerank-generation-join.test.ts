import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { generateAsyncResultFromOptions } from "../src/intent/pipeline";
import { clearAudioFitLedger, readAudioFitLedger } from "../src/intent/audio-fit-ledger";
import { rerankFinalistCount } from "../src/intent/rerank-weights";
import { reactionAdjustedFitSamples, rerankVerdictsFromEntries } from "../src/intent/reaction-rerank-feedback";
import type { ReactionEntry } from "../src/intent/reaction-ledger";
import type { SampleBank } from "../src/sample-library/factory";
import type { GenerateOptions } from "../src/ai/types";

/**
 * THE JOIN, PROVEN AT THE SOURCE (F2 closure).
 *
 * Three objects must agree on ONE identity or the feed silently joins nothing:
 * the rerank that records the observation, the pipeline that stamps the result
 * the apply surface reads, and the reaction ledger that carries the human's
 * verdict. This spec runs the REAL pipeline with the REAL rerank (only the
 * offline renderer is faked, because jsdom has no OfflineAudioContext) and
 * asserts the ledger's generationId is exactly the one the result carries —
 * then drives the full loop: human applies a different candidate → the fit
 * input's ground truth moves to it.
 */

function sineBuffer(): AudioBuffer {
  const length = 8192;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    left[i] = Math.sin((i / 44100) * 2 * Math.PI * 220) * 0.5;
    right[i] = left[i] * 0.9;
  }
  return {
    numberOfChannels: 2,
    length,
    sampleRate: 44100,
    duration: length / 44100,
    getChannelData: (channel: number) => (channel === 0 ? left : right),
  } as unknown as AudioBuffer;
}

const options: GenerateOptions = {
  genre: "house",
  style: "Driving",
  seed: "rerank-generation-join",
  stepCount: 16,
  ghostWeight: 0.3,
  microWeight: 0.2,
  velocityVariation: 0.3,
  temperature: 1,
  replaceMode: "new",
  applyGrooveSettings: false,
  candidateCount: 4,
  symbolicCandidates: 0,
};

beforeEach(() => {
  clearAudioFitLedger();
});

describe("rerank generation identity", () => {
  it("the audio-fit ledger records the SAME id the pipeline stamps on the result", async () => {
    const doc = createDefaultProject();
    const result = await generateAsyncResultFromOptions(doc, options, {
      includeBank: true,
      sound: { bank: {} as SampleBank, render: async () => sineBuffer() },
    });

    const generationId = result.selection?.rerankGenerationId;
    expect(generationId, "the pipeline must stamp the generation identity").toMatch(/^gen-\d+$/);

    const observations = readAudioFitLedger();
    const recorded = observations.find((observation) => observation.generationId === generationId);
    expect(recorded, "the rerank must have recorded the observation under that exact id").toBeDefined();

    // And the observation describes the same finalists the bank holds.
    const bank = result.bank ?? [];
    expect(bank.length).toBeGreaterThan(2);
    expect(recorded!.candidates).toHaveLength(rerankFinalistCount(bank.length, undefined));
    const bankIndexes = new Set(bank.map((entry) => entry.candidateIndex));
    for (const candidate of recorded!.candidates) {
      expect(bankIndexes.has(candidate.candidateIndex)).toBe(true);
    }
  }, 30_000);

  it("carries the human's pick back to that observation (the whole loop)", async () => {
    const doc = createDefaultProject();
    const result = await generateAsyncResultFromOptions(doc, options, {
      includeBank: true,
      sound: { bank: {} as SampleBank, render: async () => sineBuffer() },
    });
    const generationId = result.selection!.rerankGenerationId!;
    const recorded = readAudioFitLedger().find((observation) => observation.generationId === generationId)!;
    const engineWinnerIndex = recorded.candidates[recorded.selectedIndex]!.candidateIndex;
    const otherCandidate = recorded.candidates.find((candidate) => candidate.candidateIndex !== engineWinnerIndex)!;
    expect(otherCandidate).toBeDefined();

    const verdict: ReactionEntry = {
      id: "rx-join",
      createdAt: 1,
      routeKind: "candidateUse",
      action: "generate:pattern:abs",
      trackIds: [],
      beforeHash: "aaaaaaaa",
      afterHash: "bbbbbbbb",
      outcome: "kept",
      resolvedAt: 2,
      generationId,
      candidateIndex: otherCandidate.candidateIndex,
    };
    const adjusted = reactionAdjustedFitSamples([recorded], rerankVerdictsFromEntries([verdict]));

    expect(adjusted.report).toEqual({ generations: 1, dropped: 0, retargeted: 1, untouched: 0 });
    const kept = adjusted.samples.filter((sample) => sample.kept);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.generationId).toBe(generationId);
    // The kept sample is the candidate the human applied, not the engine's.
    const keptFirstPass = adjusted.samples.find((sample) => sample.kept)!.firstPass;
    const engineFirstPass = recorded.candidates[recorded.selectedIndex]!.firstPass;
    expect(keptFirstPass).toBe(otherCandidate.firstPass);
    expect(keptFirstPass).not.toBe(engineFirstPass);
  }, 30_000);

  it("drops the generation when the human reverted the applied candidate", async () => {
    const doc = createDefaultProject();
    const result = await generateAsyncResultFromOptions(doc, options, {
      includeBank: true,
      sound: { bank: {} as SampleBank, render: async () => sineBuffer() },
    });
    const generationId = result.selection!.rerankGenerationId!;
    const verdict: ReactionEntry = {
      id: "rx-undo",
      createdAt: 1,
      routeKind: "candidateUse",
      action: "generate:pattern:abs",
      trackIds: [],
      beforeHash: "aaaaaaaa",
      afterHash: "bbbbbbbb",
      outcome: "undone",
      resolvedAt: 2,
      generationId,
    };
    const adjusted = reactionAdjustedFitSamples(readAudioFitLedger(), rerankVerdictsFromEntries([verdict]));
    expect(adjusted.report.dropped).toBe(1);
    expect(adjusted.samples.every((sample) => sample.generationId !== generationId)).toBe(true);
  }, 30_000);
});
