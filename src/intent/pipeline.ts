import type { GenerateOptions } from "../ai/types";
import type { ProjectDocument } from "../project-model/types";
import { normalizeIntent, intentFromGenerateOptions } from "./normalize";
import { planGeneration } from "./plan";
import { localDeterministicProvider } from "./providers/local";
import type { GenerationContext, GenerationResult, IntentInput, IntentSpec } from "./types";

function resultFromProposal(
  plan: ReturnType<typeof planGeneration>,
  proposal: NonNullable<GenerationResult["proposal"]>,
): GenerationResult {
  return {
    status: proposal.status ?? (proposal.diagnostics.errors.length > 0 ? "rejected" : "accepted"),
    plan,
    proposal,
    diagnostics: proposal.diagnostics,
    provider: {
      id: localDeterministicProvider.id,
      version: localDeterministicProvider.version,
    },
  };
}

/** Shared local pipeline for command/apply and UI preview. */
export function generateLocalResult(
  doc: ProjectDocument,
  input: IntentInput | IntentSpec,
  mode: GenerationContext["mode"] = "apply",
): GenerationResult {
  const plan = planGeneration(input, doc);
  const proposal = localDeterministicProvider.generateSync(plan, { project: doc, mode });
  return resultFromProposal(plan, proposal);
}

export function generateLocalResultFromOptions(
  doc: ProjectDocument,
  options: GenerateOptions,
  mode: GenerationContext["mode"] = "apply",
): GenerationResult {
  return generateLocalResult(doc, intentFromGenerateOptions(options), mode);
}

export { normalizeIntent };
