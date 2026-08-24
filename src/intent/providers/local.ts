import { generatePattern } from "../../ai/generator";
import { LOCAL_ENGINE_ID, LOCAL_ENGINE_VERSION } from "../../ai/evaluation";
import type { GenerationContext, GenerationDiagnostics, GenerationPlan, GenerationProposal, GenerationProvider } from "../types";

function diagnosticsFor(quality: GenerationPlan["recipe"]["quality"]): GenerationDiagnostics {
  const warnings: string[] = [];
  if (quality && !quality.styleAccepted) warnings.push("style-distance-gate-warning");
  return {
    warnings,
    repairs: ["deterministic-anchor-and-shape-repair"],
    errors: [],
    quality,
  };
}

/** Synchronous local implementation used by commands, with async provider parity. */
export class LocalDeterministicProvider implements GenerationProvider {
  readonly id = LOCAL_ENGINE_ID;
  readonly version = LOCAL_ENGINE_VERSION;
  readonly capabilities = ["offline", "drums", "bass", "chords", "lead", "deterministic"] as const;

  generateSync(plan: GenerationPlan, context: GenerationContext): GenerationProposal {
    const pattern = generatePattern(context.project, plan.options);
    const generation = pattern.generation;
    if (!generation) throw new Error("Local generator returned no generation recipe");
    const intentMetadata = JSON.parse(JSON.stringify(plan.intent)) as Record<string, unknown>;
    pattern.generation = {
      ...generation,
      intentHash: plan.intentHash,
      intent: intentMetadata,
    };
    const diagnostics = diagnosticsFor(generation.quality);
    return { pattern, diagnostics };
  }

  async generate(
    plan: GenerationPlan,
    context: GenerationContext,
    signal?: AbortSignal,
  ): Promise<GenerationProposal> {
    if (signal?.aborted) throw new DOMException("Generation aborted", "AbortError");
    return this.generateSync(plan, context);
  }
}

export const localDeterministicProvider = new LocalDeterministicProvider();
