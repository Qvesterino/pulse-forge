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
import { buildSong, applySongCommand, parseSongLength } from "../intent/song";
import { planMixProfile, applyMixIntent } from "../intent/mix";

export interface LandingBeat {
  doc: ProjectDocument;
  prompt: string;
  template: TemplateId;
}

export interface LandingSong {
  doc: ProjectDocument;
  prompt: string;
  template: TemplateId;
  sections: number;
  totalBars: number;
  resolvedBpm: number | null;
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

/**
 * Landing song generation — "napíš vetu, počuj pesničku".
 *
 * Same offline guarantees as the beat path (no candidate bank, no ONNX, no
 * network), but through the full song pipeline: per-section generation with
 * transitions (buildSong) → genre kit + master tilt (applySongCommand) → mix
 * profile (planMixProfile/applyMixIntent, best-effort garnish). No loudness
 * render here — the landing must stay instant; the per-genre trim baked by
 * applySongCommand keeps songs consistent and the studio's USE flow runs the
 * measured loudness pass later.
 *
 * Length defaults to the SHORT form (≈20 bars) so the hero preview stays
 * digestible; an explicit length phrase in the prompt ("extended", "3
 * minutes") is honored. Cancels through `signal` (AbortError propagates).
 */
export async function generateLandingSong(
  prompt: string,
  signal?: AbortSignal,
  onProgress?: (done: number, label: string, total: number) => void,
): Promise<LandingSong> {
  signal?.throwIfAborted?.();
  const template = templateForPrompt(prompt);
  const doc = createProjectFromTemplate(template);
  const parsed = parseIntentText(prompt);
  const build = await buildSong(
    doc,
    {
      ...(parsed?.input ?? {}),
      seed: `landing-song-${Date.now().toString(36)}`,
      roles: parsed?.input?.roles ?? ["drums", "bass", "chords", "lead"],
    },
    {
      length: parseSongLength(prompt) ?? { kind: "short", label: "short" },
      onProgress: (done, label, total) => {
        signal?.throwIfAborted?.();
        onProgress?.(done, label, total);
      },
    },
  );
  signal?.throwIfAborted?.();
  let cursor = applySongCommand(doc, build).execute(doc);
  try {
    const profile = planMixProfile(build.baseIntent);
    cursor = applyMixIntent(cursor, profile).execute(cursor);
  } catch {
    /* mix is garnish — the song alone is complete */
  }
  const forged = normalizeProject({ ...cursor, name: nameFromPrompt(prompt, template) });
  return {
    doc: forged,
    prompt,
    template,
    sections: build.sections.length,
    totalBars: build.totalBars,
    resolvedBpm: build.resolvedBpm,
  };
}
