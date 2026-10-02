import { describe, expect, it, vi } from "vitest";
import type { CreativeTaskRequestV1 } from "../src/intent/creative-task-contract";
import type { CreativeTaskGoldenCaseV1 } from "../src/intent/creative-task-evaluation";
import { runCreativeTaskEvaluation } from "../src/intent/creative-task-evaluation-runner";
import type { CreativeTaskProvider, CreativeTaskProviderResult } from "../src/intent/creative-task-ollama";

const request: CreativeTaskRequestV1 = {
  version: 1,
  operation: "generate",
  prompt: "Make a beat",
  requirements: { bpmRange: null, key: null, lengthSteps: null, targetRoles: [] },
  preferences: {
    genre: null,
    style: null,
    mood: null,
    energy: null,
    density: null,
    complexity: null,
    variation: null,
  },
  preserveRoles: [],
  prohibitedRoles: [],
  unknownFields: [],
  conflicts: [],
  projectContext: { tempo: null, key: null, hasActivePattern: false, availableRoles: [] },
  evidence: [],
};

function evaluationCase(id: string): CreativeTaskGoldenCaseV1 {
  return {
    version: 1,
    id,
    family: id,
    language: "en",
    split: "held-out",
    operation: "generate",
    prompt: request.prompt,
    expected: { version: 1, status: "abstain", suggestions: {}, unknownFields: [] },
  };
}

describe("creative task evaluation runner", () => {
  it("isolates each golden case from another case's provider circuit breaker", async () => {
    const cases = [evaluationCase("first"), evaluationCase("second"), evaluationCase("third")];
    const results: CreativeTaskProviderResult[] = [
      { ok: false, error: "invalid-output", outputError: "contradictory-suggestion" },
      { ok: false, error: "provider-error" },
      { ok: true, output: { version: 1, status: "abstain", suggestions: {}, unknownFields: [] } },
    ];
    const createProvider = vi.fn((index: number): Pick<CreativeTaskProvider, "interpret"> => ({
      interpret: vi.fn(async () => results[index]!),
    }));

    const run = await runCreativeTaskEvaluation({
      cases,
      createProvider,
      makeRequest: () => request,
    });

    expect(createProvider.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    expect(run.processedCases).toBe(3);
    expect(run.modelRequestsAttempted).toBe(3);
    expect(run.modelResponses).toBe(2);
    expect(run.providerFailures).toEqual([
      { id: "first", error: "invalid-output", outputError: "contradictory-suggestion" },
      { id: "second", error: "provider-error" },
    ]);
    expect(run.predictions).toEqual([
      { id: "first", output: null },
      { id: "third", output: { version: 1, status: "abstain", suggestions: {}, unknownFields: [] } },
    ]);
  });

  it("records a thrown provider as a per-case failure and continues", async () => {
    const cases = [evaluationCase("throws"), evaluationCase("continues")];
    const createProvider = (index: number): Pick<CreativeTaskProvider, "interpret"> => ({
      interpret:
        index === 0
          ? async () => {
              throw new Error("offline");
            }
          : async () => ({
              ok: true,
              output: { version: 1, status: "abstain", suggestions: {}, unknownFields: [] },
            }),
    });

    const run = await runCreativeTaskEvaluation({ cases, createProvider, makeRequest: () => request });

    expect(run.processedCases).toBe(2);
    expect(run.providerFailures).toEqual([{ id: "throws", error: "provider-error" }]);
    expect(run.predictions.map((prediction) => prediction.id)).toEqual(["continues"]);
  });
});
