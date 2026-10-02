import type { CreativeTaskRequestV1 } from "./creative-task-contract";
import type { CreativeTaskGoldenCaseV1, CreativeTaskPredictionV1 } from "./creative-task-evaluation";
import type {
  CreativeTaskProvider,
  CreativeTaskProviderError,
  CreativeTaskProviderResult,
} from "./creative-task-ollama";

export interface CreativeTaskEvaluationProviderFailure {
  id: string;
  error: CreativeTaskProviderError;
  outputError?: string;
}

export interface CreativeTaskEvaluationRun {
  predictions: CreativeTaskPredictionV1[];
  providerFailures: CreativeTaskEvaluationProviderFailure[];
  processedCases: number;
  modelRequestsAttempted: number;
  modelResponses: number;
}

/**
 * Run each example through a fresh provider instance. Production providers may
 * open a circuit after repeated failures; sharing that state across unrelated
 * golden rows would skip the rest of an offline evaluation after early errors.
 */
export async function runCreativeTaskEvaluation(args: {
  cases: readonly CreativeTaskGoldenCaseV1[];
  createProvider: (index: number) => Pick<CreativeTaskProvider, "interpret">;
  makeRequest: (entry: CreativeTaskGoldenCaseV1) => CreativeTaskRequestV1;
  onCaseStart?: (entry: CreativeTaskGoldenCaseV1, index: number, total: number) => void;
  onCaseResult?: (
    entry: CreativeTaskGoldenCaseV1,
    result: CreativeTaskProviderResult,
    index: number,
    total: number,
  ) => void;
}): Promise<CreativeTaskEvaluationRun> {
  const run: CreativeTaskEvaluationRun = {
    predictions: [],
    providerFailures: [],
    processedCases: 0,
    modelRequestsAttempted: 0,
    modelResponses: 0,
  };

  for (const [index, entry] of args.cases.entries()) {
    args.onCaseStart?.(entry, index, args.cases.length);
    const provider = args.createProvider(index);
    const request = args.makeRequest(entry);
    let result: CreativeTaskProviderResult;
    try {
      result = await provider.interpret(request);
    } catch {
      result = { ok: false, error: "provider-error" };
    }

    run.processedCases += 1;
    if (result.ok) {
      run.modelRequestsAttempted += 1;
      run.modelResponses += 1;
      run.predictions.push({ id: entry.id, output: result.output });
    } else {
      if (result.error !== "circuit-open" && result.error !== "invalid-request" && result.error !== "aborted") {
        run.modelRequestsAttempted += 1;
      }
      if (result.error === "invalid-output") {
        run.modelResponses += 1;
        run.predictions.push({ id: entry.id, output: null });
      }
      run.providerFailures.push({
        id: entry.id,
        error: result.error,
        ...(result.error === "invalid-output" ? { outputError: result.outputError } : {}),
      });
    }
    args.onCaseResult?.(entry, result, index, args.cases.length);
  }

  return run;
}
