/**
 * Landing beat generation (viral growth plan A1) — "napíš vetu, počuj beat".
 *
 * Runs the REAL intent engine entirely client-side on a template project:
 * parse → deterministic generate (single proposal, no candidate bank, no
 * ONNX ranker, no model download — the landing must stay instant) → apply
 * the winning proposal to the template document functionally (same command
 * the studio's USE button executes, same normalize pass the store runs).
 *
 * The result is an ordinary ProjectDocument: it encodes into a share code
 * (hero preview via EmbedApp), opens through the studio handoff, and could
 * be published to the gallery unchanged.
 */

import type { ProjectDocument } from "../project-model/types";
import { createProjectFromTemplate, type TemplateId } from "../project-model/templates";
import { normalizeProject } from "../project-model/schema";
import { parseIntentText } from "../intent/text-parser";
import { generateAsyncResult } from "../intent/pipeline";
import { applyGenerationResultCommand } from "../commands/commands";

export interface LandingBeat {
  doc: ProjectDocument;
  prompt: string;
  template: TemplateId;
}

/** Genre keywords → template. Checked against the RAW prompt (the intent
 * pipeline normalizes genre independently for generation; template choice
 * only needs a coarse bucket, so it must not depend on parser internals). */
const TEMPLATE_HINTS: ReadonlyArray<{ words: readonly string[]; template: TemplateId }> = [
  { words: ["trap", "808", "drill"], template: "trap" },
  { words: ["techno", "rave", "acid"], template: "techno" },
  { words: ["garage", "ukg", "2-step", "2step"], template: "ukg" },
  { words: ["ambient", "lofi", "lo-fi", "chill", "atmospheric"], template: "ambient" },
  { words: ["house", "deep", "disco"], template: "house" },
];

export function templateForPrompt(prompt: string): TemplateId {
  const text = prompt.toLowerCase();
  for (const hint of TEMPLATE_HINTS) {
    if (hint.words.some((word) => text.includes(word))) return hint.template;
  }
  return "house";
}

function nameFromPrompt(prompt: string, template: TemplateId): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (clean.length >= 3) return clean.slice(0, 48);
  return `${template} forged beat`;
}

/**
 * Generate one forged beat from a free-text prompt. Cancels cleanly through
 * `signal` (AbortError propagates — callers treat abort as a no-op).
 * Generation failures REJECT with a readable message; the landing UI shows
 * them inline instead of leaving a spinner.
 */
export async function generateLandingBeat(prompt: string, signal?: AbortSignal): Promise<LandingBeat> {
  const template = templateForPrompt(prompt);
  const doc = createProjectFromTemplate(template);
  const parsed = parseIntentText(prompt);
  const result = await generateAsyncResult(
    doc,
    {
      ...(parsed?.input ?? {}),
      seed: `landing-${Date.now().toString(36)}`,
      // Single deterministic proposal — no candidate bank, no ranker, no
      // symbolic prior: zero model traffic, sub-second generate.
      candidateCount: 1,
      symbolicCandidates: 0,
      roles: ["drums", "bass"],
    },
    { mode: "apply", signal, includeBank: false },
  );
  if (!result.proposal) {
    const reason = result.diagnostics.errors[0] ?? result.diagnostics.fallbackReason ?? "generation rejected";
    throw new Error(reason);
  }
  const command = applyGenerationResultCommand(doc, result, nameFromPrompt(prompt, template));
  const forged = normalizeProject({ ...command.execute(doc), name: nameFromPrompt(prompt, template) });
  return { doc: forged, prompt, template };
}
